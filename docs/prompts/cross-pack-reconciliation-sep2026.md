# Cross-pack reconciliation — data platform × design-v2 × SnapTrade (15-Sep-2026)

**Why this exists.** Three prompt packs were written in three sessions over six days and do not reference each other. Grepped 15-Sep: `docs/prompts/design-v2/**` contains zero mentions of `data-platform`, `market-data`, chart tiles, `lake_*`, BigQuery or Dataform; `claude-code-prompts-data-platform.md` contains zero mentions of `design-v2`, any `W0x`/`W1x` prompt, `us-stock` or `/stock/`. The SnapTrade pack is referenced by design-v2 (`00-shared-context.md` §1, W08) but the two disagree on names and FX. Run as written, the packs build one read path twice, name one enum two ways, and convert currency two ways.

**Evidence.** stockbook-monorepo @ `c907225c` (branch `feat/MONEY-1466`, A1 in flight, cloudbuild edits uncommitted); `docs/prompts/design-v2/` (12-Sep, 34 prompts + README + shared context); `docs/prompts/data-platform/claude-code-prompts-data-platform.md` + `data-platform-plan-v2.3-sep2026.md` (14-Sep, LOCKED; same bytes in `archive-docs/reports/`); `archive-docs/reports/claude-code-prompts-snaptrade.md` (12-Sep, P18–P33). Sessions: data warehousing `cse_01FThtjSxsxMLuvCtf86MPbN`, brokerage API `cse_01Cv6BabJYmryDeUDxEqcgqW`, web-app prompts `cse_01L8DRtkGYfgnSjjPhrCxZDZ`.

**Already landed (git log):** S0/S0b/S0c done 14-Sep (measurement docs in `docs/reference/`; PRs #425 MONEY-1463, #426 MONEY-1464), S1 lake foundation (MONEY-1465, merged as #427), A1 `usemoney-market-data` service (MONEY-1466 — three commits on the branch; `apps/market-data/` exists with `udf.ts`/`health.ts`; `scripts/ops/setup-market-data-{sa,lb}.sh`, `market-data-smoke.sh`, `lake-smoke.ts`). Nothing from design-v2 or SnapTrade has started; `packages/core/src/market-data/{tiles,quotes}` do not exist yet (A2/A4 pending). Note that `docs/prompts/design-v2/` and `docs/prompts/data-platform/` are **untracked** in git (`??` on 15-Sep) — the packs exist only in the working tree; the README's "written against `main` @ `c8129049`" describes the code, not the docs. Commit them (a `docs/MONEY-…` branch) before the first prompt session, or a stray `git clean` removes 34 prompts.

---

## 1. Who builds which backend

There is no separate "US data consumer backend" to build before the UI, because every design-v2 W-prompt already ships its own: a `## Data wiring` section per surface that builds the server actions, the `packages/services` layer, the `apps/api` `/v1` mirror and the Redis cache together (the P14 rule, restated in `00-shared-context.md` §2.2 and §5). W09 alone specifies seven actions → `us-stock.service.ts` → `GET /v1/stocks/:symbol/us/*`. The one deliberately backend-only prompt on the US path is SnapTrade **P18**, and W08 names it as a prerequisite.

The data-platform pack builds the *shared serving layer* the surfaces read prices from: A1 service (done), A2 D1 tiles, A3 chart cut-over, A4 Redis-first quotes, A5 intraday buffers, C4 event consumers. It is market-agnostic (`tiles/{market}/…`, `q:{market}:{listing_id}`) and is the only part of the 16-week programme the US product waits on. Tracks B (warehouse, Mongo containment) and D (rate limiter, import upload, api container, worker split) are invisible to a US user except where §2 says otherwise.

So the answer to "backend first, or UI, or broker?" is: **A2→A4 first (shared serving), then vertical slices in the order in §5, with P18 as the only backend-only step, placed immediately before W08.**

---

## 2. Collisions — what disagrees, and which prompt yields

Line numbers refer to the files as they stood on 15-Sep before this session's edits (W09 and the README moved by a few lines afterwards).

| # | Where | What disagrees | Resolution | Edit lands in |
|---|-------|----------------|------------|---------------|
| C1 | W09 line 19 "Chart: EOD closes from `Candle`", line 25 `getUsStockCandlesAction(range)`, line 28 `GET /:symbol/us/candles` **vs** A2 §5 (tiles served by `/udf/history` on the market-data service) and A3 §3 (`TradingViewAdvancedChart.tsx` `UDF_BASE_URL` flips to the service behind `MARKET_DATA_TILES`) | Two candle read paths for one chart; W09's is obsolete the day A3 flips. | W09 reuses the shared TradingView chart with the US listing id and adds **no** candles action or route; the data source is whatever A3 has pointed `UDF_BASE_URL` at. Mobile (M20 line 17 reads `/us/candles`) takes daily bars from the market-data service `/udf/history` directly — A1 §3: public daily bars need no auth, and the CDN is the point. | **W09 (applied)**; M20 line 17 (pending); A3 §3 addendum: also flip `/v1/market/historical` in apps/api (M16 line 13) so India mobile charts get the same bytes as web (pending). |
| C2 | W08 line 26 `broker: SNAPTRADE_ROBINHOOD` **vs** SnapTrade P19–P29 headings: `ROBINHOOD`, `PUBLIC`, `WEBULL`, `TASTYTRADE`, `ETRADE`, `MOOMOO`, `VANGUARD`, `ETORO` (rail carried by `BrokerConnection.rail = SNAPTRADE`, P18 §1a/§1d) and the `_SNAPTRADE` suffix only where a DIRECT adapter coexists: `INTERACTIVE_BROKERS_SNAPTRADE`, `ZERODHA_SNAPTRADE`, `UPSTOX_SNAPTRADE` | Same enum, two naming schemes. | P18 owns the schema; W08 follows it. | W08 line 26 (pending). |
| C3 | P18 §7a "totals … converted at read time via `FxRate` for the requested display date (INR default; USD toggle)" **vs** Decision 02 (spot hourly for values, RBI reference of trade date for cost basis/LRS, never mixed — `00-shared-context.md` §1) and W10 line 25 `holdings-fx-logic.ts` (values at spot via `getUsdToInr`, cost at `fxRateOnTrade`, missing → `null`, never `NaN`) | Two conversion rules for the same totals; P18 runs first and would ship the wrong one. | Decision 02 binds. P18 §7a implements exactly W10's `holdings-fx-logic.ts` (spot for values, `fxRateOnTrade` for cost, missing rate → flagged row, `DataGapBanner` when spot is stale > 24 h) and reads the display currency from W12's `primaryCurrency`, not its own toggle. `FxRate` (daily, `us-eod-sync`) stays the RBI/YAHOO reference store; per-activity `fxRate` from the broker is data, not a conversion source. | P18 §7a/§7b (pending). W10 then consumes, does not rewrite. |
| C4 | W08 line 21 (CSV/PDF ≤ 20 MB through the existing tradebook import shell), line 27–28 `commitUsStatementAction(batch)` "via the existing import job", line 30 `POST /v1/imports/preview (multipart)` **vs** D3 (the existing path base64-encodes the file into a Server Action and a Pub/Sub message; Vercel functions cap ~4.5 MB, so the path "cannot work at its own limit"; D3 replaces it with `POST /v1/imports/upload-url` → signed V4 PUT → `POST /v1/imports/{id}/commit`, ≤ 25 MB) | W08 promises 20 MB PDFs over a path D3 says caps at ~4.5 MB. | D3 before W08. W08's Step 1 uploads via D3's signed URL; preview and commit take `{importId}` and read the object by `objectPath+generation`; the multipart route is dropped. | W08 lines 21/27/30 (pending). |
| C5 | P18 §6b picker ("Connect via SnapTrade" cards in `apps/web/app/brokers/client.tsx`, per-broker history line, locked state, degraded banner) **vs** W08 §1 (`/brokers` gains the designed US section: persona-ordered Link/Import cards, broker grid, "More brokers · 20+ VIA SNAPTRADE", consent screen) | Same surface built twice. | P18 ships the minimum its acceptance needs (flag-gated card list, sandbox); W08 replaces it. Do not polish P18's picker. | Note only; optional one-line "W08 supersedes this UI" in P18 §6b. |
| C6 | W09 line 20 tabs OVERVIEW · FINANCIALS · INSIDERS · HOLDERS · FILINGS **vs** C4 §4 "stock page 'Events' tab reading `InstrumentEvent` (server action in `stock-tabs.ts` AND `apps/api` v1 `stocks.ts`)" — C4 knows only the India page; and B6 lever 3 ("`us_filings` → `filing_registry` (C1); Mongo keeps 2 years") **vs** W09's FILINGS timeline reading `UsFiling` with no window stated | The US page has no Events tab slot; its filings timeline silently shortens to 2 y after B6. | W09 gains an EVENTS tab seam (engine-gated per `00-shared-context.md` §4 until C4 lands) and states the 2-y window on FILINGS with a "more on file at SEC" link. C4 §4 names the US variant: `us-stock.ts` action + `/v1/stocks/:symbol/us/events` sub-path. | **W09 (applied)**; C4 §4 (pending). |
| C7 | W09 line 27 `Alert.kind = "PRICE_EOD"` + `alert-evaluator` after `us-eod-sync`; C4 §2 `HOLDING_EVENT` / `WATCHLIST_EVENT` on the same evaluator; W05 "signal watches + evaluator"; C4 §1 reverse index includes watchlists, keyed `hold:{market}:{listing_id}` **vs** W09 line 26 `WatchlistItem` gains `market`/`exchange` | Three prompts extend one enum and one processor; C4 needs W09's `WatchlistItem.market` to key US rows. | Additive, not contradictory: whoever runs second rebases onto the enum. C4 treats a missing `market` as `IN` (the `isSet:false` arm, MONEY-1050 family) so it can run before or after W09. | Note only. |
| C8 | README open item 7 (Vercel vs Cloud Run for `apps/api`; A01 SSE needs a streaming runtime) **vs** D4 (`apps/api` → `usemoney-api` on Cloud Run, QA first, DNS cut wk 7–8) | The open item is already decided by the other pack. | D4 settles it: A01's `/v1/chat/stream` targets Cloud Run. Run D4 (QA) before A01, or ship A01 QA-only until the DNS cut. | README (applied — item 7 now points at D4). |

Two more mismatches are single lines, not collisions: README open item 5 lists the prompts that may add a `V1_ENDPOINTS` family (pinned at 38) — C4 §4 `/v1/events?listing=` and D3 `/v1/imports/upload-url` are missing from that list (added to README); and `00-shared-context.md` §1 says the data-platform pack does not exist (it lists quant and SnapTrade prompts only) — a pointer is added to the README rather than the shared context, to keep the shared context stable for sessions already running.

---

## 3. Dependencies the packs do not state

| Prompt | Needs first | From | Why |
|--------|-------------|------|-----|
| W09 chart, W01 US tile, W10 US LAST column, W02 US EOD close | A2 + A3 (tiles + flip), A4 (quotes) | data-platform | Every US price on those surfaces reads the quote store / chart the service serves. Until A3/A4, they read `LatestQuote` + Yahoo-backed UDF — they work, but slower and with a second read path to retire. |
| W09 FILINGS (older than 2 y), any "all filings" claim | C1 `filing_registry` + a serving path for it | data-platform | B6 lever 3 leaves 2 y in Mongo. No prompt builds a product reader over `filing_registry`; the tab states the window until one exists. |
| W09 EVENTS tab, W10 holdings event alerts | C1 → C2 → C3 → C4 | data-platform | `InstrumentEvent` (Mongo, 30 d) is C1's projection; the reverse index and evaluator kinds are C4. |
| W08 statement import (20 MB PDF) | D3 | data-platform | C4 above. |
| W08 link flow, W10 currency column, W11 lots | P18 (schema §1, rail §2, connect §3, sync §4, webhooks §5, flags §6) | SnapTrade | README item 8 already says so for `currency`; the rest of W08 §Data wiring is P18's surface. |
| W08/W10/W11 in production | RBI reference-rate fetcher (`fetchFromRbi` → null, MONEY-217) | repo | README item 3. Env overrides carry QA only. |
| C4 §1 reverse index for US holdings | P18 §7c `resolveInstrument` (SnapTrade positions carry `exchange` as a MIC or `"UNKNOWN"`, never NSE) and a shared `listing_id` builder (S1 below) | SnapTrade + data-platform | Without resolution a US holding cannot be keyed `hold:US:{listing_id}` and its owner never gets the 8-K alert C4 promises. |
| M20 US layer | W08–W12 (stated) **and** A2/A3 for bars (C1) | design-v2 + data-platform | M20 line 17 reads bars through a route this note removes. |
| A01 `/v1/chat/stream` | D4 (`usemoney-api` on Cloud Run) | data-platform | C8 above. |
| W04 `LocalEngine` daily bars | read through `CandleRepository` (hot + cold shards), never `prisma.candle` | data-platform B6 lever 5 | The hot window shrinks to the measured need (~2 y); a direct Mongo read silently truncates every backtest older than that. Same rule for W06's `us-eod-prices` research tool. |
| D5 worker split | P18 §4e lanes (`SNAPTRADE_US`/`SNAPTRADE_IN`), §4g `snaptrade-reconcile`, §5 `snaptrade-event`, §6c `snaptrade-cleanup` | SnapTrade | D5 classifies processors by workload; four new ones arrive from the other pack. |
| Data-platform wk 13–16 "MCP / OpenAPI (next programme)" | W13 hosted MCP v1 | design-v2 | Extend W13's server; do not start a second one. |

---

## 4. Seams no pack names (each needs one owner)

**S1 — one `listing_id` helper.** A2 §1 defines the tile key (`{symbol}:{exchange}` for IN, `Candle.listingId` = `{symbol}:{exchange}:{listingStart}` for US); B3 defines the SCD-2 identity in `lake_silver`; P18 §7c resolves SnapTrade positions to `UsInstrument` by `openFIGIComposite`; C4 keys Redis by `listing_id`; W09's footer prints "Listing {listingId}". Five prompts, no shared function. Born in A2 §1 as `packages/core/src/market-data/listing-id.ts` (`toListingId(UsInstrument | InstrumentMapping)`, `parseListingId`), imported by P18 §7c, C4 §1 and W09.

**S2 — mobile bars and the intraday token.** M16 line 13 reads India bars from `/v1/market/historical` (apps/api, Yahoo-backed); M20 read US bars from `/us/candles`; A1 §3 mints the intraday token from a **web** server action only. Recommendation: daily bars for every client come from the market-data service (public, CDN); apps/api gains `POST /v1/market/token` mirroring `mintMarketDataToken()` before any mobile intraday range (M16's "1D intraday bars if …"). Alternative: apps/api proxies both to the core tile reader — one more hop, no CDN. Shaswat's call (§7).

**S3 — US tile coverage before B4.** A2 §3: until `lake_gold.adjusted_bar_d1` exists, the US tile job builds only the `us-interest.ts` set (watchlists + holdings + SPY constituents + ephemeral page interest). A long-tail US symbol opened from search has no tile for weeks 1–5. The `/udf/history` reader (A2 §5) needs a `CandleRepository` fallback for a missing US tile, marked `source: "candles"` in the manifest, so W09's acceptance ("renders every tab from real rows or the honest gap") does not depend on which symbol is tried.

**S4 — `Candle` readers after B6.** Listed in §3 for W04/W06; the general rule belongs in `00-shared-context.md` §2 the next time it is edited: "daily/intraday history is read through `CandleRepository` or the market-data service, never `prisma.candle` — the Mongo window is a cache, not the series."

**S5 — `V1_ENDPOINTS` families.** C4 (`/v1/events`), D3 (`/v1/imports/upload-url` is a sub-path, fine), A01, M22, W13 all touch the count pinned at 38. One list, in the README (updated).

---

## 5. The US track, ordered

Ahead of everything: A1 is on `feat/MONEY-1466` — finish, review, merge.

1. **A2 → A3 → A4** (data-platform Track A, weeks 1–4 of plan v2.3 §5). The shared serving layer for both markets; nothing US-specific to add except the S3 fallback.
2. **W12** — onboarding fork + `market/residency/primaryCurrency` + Settings → Market preferences. Small; every US surface and P18's display currency (C3) hang off it.
3. **W09** (as patched) — the US stock page. Needs W00 for the named components and only the *gated* half of W06 (the CTA stays "Research · India only today" while `us-stock-research` is off, which W09 already specifies). No third-party account, verifiable from India with real AAPL rows, and the page every holding row will link to.
4. **D3** — signed-URL import (small, C4). Then **P18** (backend, one PR, sandbox-only, flags off) immediately followed by **W08**. Per-broker P19–P29 trickle after W08 behind their own flags; verification is sandbox + fixtures + per-broker beta (P18 run protocol), so they never block the surface.
5. **W10 → W11.** Both need W08 + W12 + the RBI fetcher for production.
6. **C4** once C1–C3 have landed (Track C weeks 1–8): fills W09's EVENTS seam and the US reverse-index alerts. Sequence after W09/W10 or rely on the missing-`market` arm (C7).
7. **M20** after W08–W12 and A3.

Parallel with all of it: Track B (B0/B8 embeddings, B1–B7) and D2/D4/D5 — they change nothing a US surface reads, except the `CandleRepository` rule (S4). W06 (StockSage US arm) and W01 US drop-ins can slot in anywhere after W12.

The README's overall sequence puts India mobile (M00 → A01 → M10 → M11 → M12 → M13 → M14) before the US track. The only India prerequisites the US track has are W00 and W12; whether US or India mobile goes first is a business call, not a dependency (§7).

---

## 6. Edits

**Applied 15-Sep (this session):**
- `docs/prompts/design-v2/web/W09-us-stock-page.md` — chart line rewritten to the shared TradingView path (C1); `getUsStockCandlesAction` and `/us/candles` removed; EVENTS tab seam + FILINGS window added (C6); a "Cross-pack prerequisites" line under *Read first* pointing at A2/A3/A4, C1/C4 and this note.
- `docs/prompts/design-v2/README.md` — new section "US track (cross-pack order)"; open item 5 lists C4 and D3; open item 7 points at D4; open item 9 (mobile bars source) added; a pointer to the data-platform pack and to this note.

**Pending — need a go-ahead because they touch the other two packs (both copies: `archive-docs/reports/` and `docs/prompts/data-platform/`):**
- W08 line 26: `SNAPTRADE_ROBINHOOD` → `ROBINHOOD` with `rail: SNAPTRADE` (C2). W08 lines 21/27/30: import over D3's upload-url + commit; drop the multipart preview (C4).
- P18 §7a/§7b: adopt Decision 02 via `holdings-fx-logic.ts`; display currency from W12 (C3). P18 §6b: "W08 supersedes this UI" (C5).
- A2 §1: `listing-id.ts` helper (S1). A2 §5: `CandleRepository` fallback for a missing US tile (S3). A3 §3: also flip apps/api `/v1/market/historical` (C1/S2). A1 or A5: `POST /v1/market/token` in apps/api (S2). C4 §4: name the US variant (C6). C4 §1: import `listing-id.ts` + P18 `resolveInstrument` (S1). D5: classify the four SnapTrade processors (§3).
- M20 line 17: bars from the market-data service (C1/S2). M16 line 13: same, after A3's addendum.

---

## 7. Open — Shaswat's calls

1. Mobile bars: market-data service directly (CDN, no auth hop; recommended) or apps/api proxy (one route family, one more hop)? Decides M16/M20 and the A3 addendum.
2. US track before or after India mobile (README sequence)? The dependency graph allows either.
3. Go-ahead for the pending edits in §6, or only the design-v2 ones.
4. Unchanged from the packs: RBI fetcher (MONEY-217) before W08 ships to prod; D4 timing vs A01; invoice lines for the B6 downgrade gate.
