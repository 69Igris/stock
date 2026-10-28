# UseMoney Workers - CLAUDE.md

## Overview

Background job workers for UseMoney. Receives Google Cloud Pub/Sub push messages
via HTTP and processes long-running tasks like trade pairing, CSV imports,
broker syncs, market data pipelines, AI research, document processing, and
portfolio roasting.

**Package:** `@usemoney/workers` **Transport:** Google Cloud Pub/Sub (push
subscriptions) **Runtime:** Hono HTTP server on Cloud Run Service

---

## Endpoints

> Partial list (the original core jobs). `src/index.ts` mounts 66 `/jobs/*` routes plus `/health` — counted 2026-09-02 with `grep -c '^app.route("/jobs/' src/index.ts`, a spelling given because the previous figure ("66 routes", 2026-09-01) counted something else and drifted within a day. Newer jobs (login-briefing, newsletter-publish, stock-document-sync/embed, news/filings syncs, xbrl-projection, xbrl-ratios, alert-evaluator, account-deletion, strategy-scan, …) follow the same route→processor pattern.

| Method | Path                              | Pub/Sub Topic                                                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | --------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                         | ---                                                             | Health check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/jobs/trade-pairing`             | `trade-pairing`                                                 | FIFO trade pairing computation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/jobs/csv-import`                | `csv-import`                                                    | CSV/XLS trade import processing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/jobs/broker-sync`               | `broker-sync`                                                   | Broker data synchronization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/jobs/instrument-sync`           | `instrument-sync`                                               | Instrument master data sync (daily)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/price-sync`                | `price-sync`                                                    | Price data sync (daily post-market)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/sector-enrichment`         | `sector-enrichment`                                             | Sector/industry enrichment (weekly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/mf-sync`                   | `mf-sync`                                                       | AMFI mutual fund NAV sync (daily) — writes `MutualFundMaster`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/jobs/mf-nav-propagate`          | `mf-nav-propagate`                                              | Propagate `MutualFundMaster` NAVs → user `MutualFund` rows (daily, both envs; MONEY-1074)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/peers-sync`                | `peers-sync`                                                    | Derived `StockPeers` rebuild from our own instruments+ratios+quotes (daily, both envs; MONEY-1145)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/jobs/mf-metadata-sync`          | `mf-metadata-sync`                                              | MF metadata enrichment via AMFI (weekly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/stock-research`            | `stock-research`                                                | AI research jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/jobs/document-process`          | `document-process`                                              | Document extraction & report generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/jobs/stock-document-extract`    | `stock-document-extract`                                        | Document AI / pdf-parse text extraction of PENDING stock PDFs (MONEY-783). Daily 22:00 IST both envs; oldest-first + self-chaining since MONEY-1255                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/portfolio-roast`           | `portfolio-roast`                                               | Portfolio roast analysis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/comparison-analysis`       | `comparison-analysis`                                           | Deep stock/MF comparison (MONEY-553)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/jobs/investor-rollup`           | `investor-rollup`                                               | Nightly investor self-learning rollup (MONEY-789 B4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/jobs/report-archive-sync`       | `report-archive-sync`                                           | Archive-first capture of the NSE/BSE report set (MONEY-1097 P2) — fetches bytes, parses nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/jobs/nse-announcements-sync`    | `nse-announcements-sync`                                        | Whole-market NSE announcements leg + BSE-side dedupe (MONEY-1098 P5.1, daily 21:15 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/jobs/ownership-sync`            | `ownership-sync`                                                | Weekly per-symbol shareholding / PIT / SAST / pledge fan-out (MONEY-1098 P5.4, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/annual-reports-sync`       | `annual-reports-sync`                                           | Annual-report PDF discovery + integrated-filing-results leg (MONEY-1098 P5.5, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/ipo-sync`                  | `ipo-sync`                                                      | Upcoming/current IPO issues → `UpcomingIpo` (MONEY-1098 P5.6, daily 09:00 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/index-constituent-sync`    | `index-constituent-sync`                                        | Weekly IndexConstituent refresh — archive-first `ind_*list.csv`, static/mcap fallbacks (MONEY-1100 P4.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/surveillance-sync`         | `surveillance-sync`                                             | Daily NSE ASM + GSM surveillance flags from the live JSON reports (MONEY-1189 P4.5, 20:15 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/institutional-flow-sync`   | `institutional-flow-sync`                                       | Daily FII/DII cash-market flows from NSE `/api/fiidiiTradeReact` (MONEY-1108 P8d, 20:30 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Method | Path                              | Pub/Sub Topic                                                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------    | ------------------------                                        | ---------------------------------------------------------------------------------------------------------                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| GET    | `/health`                         | ---                                                             | Health check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| POST   | `/jobs/trade-pairing`             | `trade-pairing`                                                 | FIFO trade pairing computation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| POST   | `/jobs/csv-import`                | `csv-import`                                                    | CSV/XLS trade import processing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/jobs/broker-sync`               | `broker-sync`                                                   | Broker data synchronization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/jobs/instrument-sync`           | `instrument-sync`                                               | Instrument master data sync (daily)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/price-sync`                | `price-sync`                                                    | Price data sync (daily post-market)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/sector-enrichment`         | `sector-enrichment`                                             | Sector/industry enrichment (weekly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/mf-sync`                   | `mf-sync`                                                       | AMFI mutual fund NAV sync (daily) — writes `MutualFundMaster`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| POST   | `/jobs/mf-nav-propagate`          | `mf-nav-propagate`                                              | Propagate `MutualFundMaster` NAVs → user `MutualFund` rows (daily, both envs; MONEY-1074)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/peers-sync`                | `peers-sync`                                                    | Derived `StockPeers` rebuild from our own instruments+ratios+quotes (daily, both envs; MONEY-1145)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/jobs/mf-metadata-sync`          | `mf-metadata-sync`                                              | MF metadata enrichment via AMFI (weekly)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/stock-research`            | `stock-research`                                                | AI research jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| POST   | `/jobs/document-process`          | `document-process`                                              | Document extraction & report generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/jobs/stock-document-extract`    | `stock-document-extract`                                        | Document AI / pdf-parse text extraction of PENDING stock PDFs (MONEY-783). Daily 22:00 IST both envs; oldest-first + self-chaining since MONEY-1255                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| POST   | `/jobs/portfolio-roast`           | `portfolio-roast`                                               | Portfolio roast analysis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/comparison-analysis`       | `comparison-analysis`                                           | Deep stock/MF comparison (MONEY-553)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/jobs/investor-rollup`           | `investor-rollup`                                               | Nightly investor self-learning rollup (MONEY-789 B4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/jobs/report-archive-sync`       | `report-archive-sync`                                           | Archive-first capture of the NSE/BSE report set (MONEY-1097 P2) — fetches bytes, parses nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| POST   | `/jobs/nse-announcements-sync`    | `nse-announcements-sync`                                        | Whole-market NSE announcements leg + BSE-side dedupe (MONEY-1098 P5.1, daily 21:15 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/jobs/ownership-sync`            | `ownership-sync`                                                | Weekly per-symbol shareholding / PIT / SAST / pledge fan-out (MONEY-1098 P5.4, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/annual-reports-sync`       | `annual-reports-sync`                                           | Annual-report PDF discovery + integrated-filing-results leg (MONEY-1098 P5.5, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/ipo-sync`                  | `ipo-sync`                                                      | Upcoming/current IPO issues → `UpcomingIpo` (MONEY-1098 P5.6, daily 09:00 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/index-constituent-sync`    | `index-constituent-sync`                                        | Weekly IndexConstituent refresh — archive-first `ind_*list.csv`, static/mcap fallbacks (MONEY-1100 P4.3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/surveillance-sync`         | `surveillance-sync`                                             | Daily NSE ASM + GSM surveillance flags from the live JSON reports (MONEY-1189 P4.5, 20:15 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| POST   | `/jobs/macro-sync`                | `macro-sync`                                                    | Official macro series — RBI NSDP: WSS rates/ratios + forex reserves + MOSPI CPI + OEA WPI (MONEY-1106 P8b, Sat + Tue 08:00 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| POST   | `/jobs/xbrl-sync`                 | `xbrl-sync`                                                     | Company financials from NSE's own XBRL (MONEY-1113 P10 F1, 23:15 IST daily, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| POST   | `/jobs/circulars-sync`            | `circulars-sync`                                                | NSE exchange circulars over a trailing 14-day window (MONEY-1187 P11, 18:30 IST daily, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| POST   | `/jobs/xbrl-projection`           | `xbrl-projection`                                               | Projects `xbrl_filings` -> `stock_financials`, ANNUAL + QUARTERLY (MONEY-1220, 23:45 IST daily, prod-only, DISARMED unless `XBRL_PROJECTION_APPLY=true`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/xbrl-ratios`               | `xbrl-ratios`                                                   | Derives 26 of `stock_ratios`' 28 columns from our own filings + close history (MONEY-1220, 22:00 IST Mon-Fri, prod-only, same arm flag)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/jobs/financial-data-sync`       | --- (topic REMOVED)                                             | **RETIRED** (MONEY-1220). Answers **200** `{retired:true}` and drops the message. Tickertape 403s our egress; its work moved to the two rows above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/jobs/dead-letter`               | `dead-letter`                                                   | Consumes `dead-letter-${ENV}` (MONEY-1204). Logs + notifies the founder; NEVER auto-retries and NEVER nacks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| POST   | `/jobs/mf-portfolio-sync`         | `mf-portfolio-sync`                                             | AMC monthly portfolio disclosures (MONEY-1105 P8a, 12th + 20th 08:30 IST, prod-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| POST   | `/jobs/us-eod-sync`               | `us-eod-sync`                                                   | US price backbone on Tiingo — EOD + fund NAVs + derived corp actions + USDINR + CA calendar (MONEY-980/1263/1264, 11:00 IST **Tue-Sat**, **PROD-ONLY**). **The news leg (f) is RETIRED** — MONEY-1309 moved it to `tiingo-news-poll`, because this job's cron is a MARKET schedule and news is not a market. QA does NOT run it: `candles`/`fx_rates` are REFERENCE_COLLECTIONS, so QA receives what prod computed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| POST   | `/jobs/us-instrument-master-sync` | `us-instrument-master-sync`                                     | Tiingo US security master (72,685 listings) + EDGAR ticker→CIK join (MONEY-980, 10:00 IST **Tue-Sat**, **PROD-ONLY**). QA does NOT run it: `us_instruments` is nothing's FK target and IS a REFERENCE_COLLECTION, so QA receives what prod computed — and running it in QA spent ~14,000 METERED Tiingo requests a night against a per-PROCESS pacer, i.e. 2x the account ceiling. Must precede `us-eod-sync` — its active-US population does not exist until this runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/jobs/candle-evict`              | `candle-evict`                                                  | Deletes candles that have aged out — `tier:"LOADED"` past 30 days, and `tier:"WINDOW"` once the rolling 10-year window passes their year (MONEY-980, 15:00 IST daily, **PROD-ONLY**). **ARCHIVES BEFORE IT DELETES, always**: a WINDOW row is in Mongo _because_ its year was in the window, so nothing ever archived it and Mongo is the only copy — the job writes the cold shard, RE-READS the object, and deletes only what the re-read proves holds that exact natural key. Ships DISARMED (`CANDLE_EVICT_APPLY="false"`); prod-only because QA's bucket receives only the `feeds/` prefix, never `candles/`, so every shard read there answers `absent` and the job would refuse every row while burning GCS calls on false alarms                                                                                                                                                                                                                                                                                                                                                                                                                             |
| POST   | `/jobs/tiingo-news-poll`          | `tiingo-news-poll` (every 2 min, ALL SEVEN DAYS, **PROD-ONLY**) | US news poller, **every 2 minutes 24x7** (MONEY-1309). SUPERSEDES `us-eod-sync` leg (f), which rode a `0 11 * * 2-6` IST MARKET cron and therefore could not run at all on a Sunday or Monday IST — prod measured a newest article **88h old** and **29.6h** mean ingest lag while every run that DID happen reported healthy. Writes ARTICLE-level rows to `us_news_articles`, keyed on Tiingo's own `tiingoId`, with an OVERLAPPING `crawlDate` cursor in `us_news_cursor`. `us_stock_news` is left untouched and read-only until its readers migrate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/jobs/stock-document-ingest`     | `stock-document-ingest` (event-driven, NO cron)                 | **ONE DOCUMENT PER MESSAGE** (MONEY-1314). Converts a stored PDF to markdown (`${gcsPath}.md` sidecar), page-selects it, reads it with Gemini, and upserts `document_financial_extracts` — falling over to whole-PDF vision when the arithmetic gate rejects the answer. SUPERSEDES `stock-document-parse`, whose four crons are RETIRED (all four names are in `OLD_SCHEDULER_PREFIXES`, which deletes by EXACT name, not prefix). Announced at store time by the five `stock_documents` writers via `publishDocumentIngest`, gated by `DOC_INGEST_REALTIME` (ships "false"); the historical corpus is drained by the `doc-ingest-backfill` Cloud Run job — 48,092 documents still unconverted and 50,801 unparsed as of 2026-09-05, on FOUR sharded 8Gi tasks since MONEY-1339 (the serial 2Gi job was OOM-killed on 09-02 and had stalled). The page-per-message lane needed `RUN_TIME_BUDGET_MS`, `MAX_CHAIN_DEPTH` and `PARSE_SCAN_CAP`; a document-per-message lane needs none of them                                                                                                                                                                         |
| POST   | `/jobs/us-filing-insight`         | `us-filing-insight` (sweep cron + self fan-out)                 | **ONE TOPIC, TWO MESSAGE SHAPES** (MONEY-1324 P17). `{"mode":"sweep"}` from Cloud Scheduler `us-filing-insight-sweep` (`*/10 * * * *`, ALL SEVEN DAYS, **PROD-ONLY**) diffs the EX-99\* cohort of `us_filing_documents` against `us_filing_insights` and publishes `{"documentId":...}` **back onto the same topic**, one per owed document; a leaf reads that document's extracted text from GCS, analyses it and upserts one row. A message naming NEITHER is ACKed and ignored — inferring a sweep from an absent field would let one malformed leaf spend a cohort of PAID model calls. **The sweep IS the retry channel**: the route ACKs 200 on every path including a throw, so Pub/Sub never redelivers, and a `FAILED` leaf comes back only because the sweep re-selects it after a 6h cooldown (MONEY-1314's black hole was a status no query selected). Gated by `US_FILING_INSIGHT_APPLY` (ships "false" in both specs) — disarmed the sweep still selects and reports its queue depth, it just publishes nothing. PROD-ONLY because the leaves spend paid Gemini calls on inputs QA already receives by copy; QA gets `us_filing_insights` the same way |

---

## Directory Structure

```
workers/
├── src/
│   ├── index.ts                  # Hono server entry point (port 8081)
│   ├── index-auth-logic.ts       # PURE OIDC skip decision (MONEY-1093, unit-tested)
│   ├── log-boundary.ts           # MONEY-1209: wraps console.{log,warn,error} in redactSensitive — installed as the FIRST statement of index.ts
│   ├── lib/
│   │   ├── message.ts            # Pub/Sub push envelope parser
│   │   ├── pubsub-dedupe-logic.ts # PURE messageId idempotency: claim decisions, EJSON readers, store + middleware factories (MONEY-1204)
│   │   ├── pubsub-dedupe.ts      # Prisma wiring for the above (kept thin so tests never load Prisma)
│   │   ├── notifications.ts      # Notification helpers
│   │   ├── pull-subscriber.ts    # Local dev pull subscriber
│   │   ├── gcs.ts                # GCS utilities
│   │   ├── docai.ts              # Google Document AI client (MONEY-783, lazy/never-throw)
│   │   ├── embeddings.ts         # Document embeddings
│   │   └── report-renderer.ts    # PDF report rendering
│   ├── routes/
│   │   ├── health.ts             # GET /health
│   │   ├── pairing.ts            # POST /jobs/trade-pairing
│   │   ├── import.ts             # POST /jobs/csv-import
│   │   ├── sync.ts               # POST /jobs/broker-sync
│   │   ├── instrument-sync.ts    # POST /jobs/instrument-sync
│   │   ├── price-sync.ts         # POST /jobs/price-sync
│   │   ├── sector-enrichment.ts  # POST /jobs/sector-enrichment
│   │   ├── mf-sync.ts            # POST /jobs/mf-sync
│   │   ├── mf-metadata-sync.ts   # POST /jobs/mf-metadata-sync
│   │   ├── peers-sync.ts         # POST /jobs/peers-sync (MONEY-1145)
│   │   ├── research.ts           # POST /jobs/stock-research
│   │   ├── document-process.ts   # POST /jobs/document-process
│   │   ├── stock-document-extract.ts # POST /jobs/stock-document-extract (MONEY-783)
│   │   ├── roast.ts              # POST /jobs/portfolio-roast
│   │   ├── comparison.ts         # POST /jobs/comparison-analysis (MONEY-553)
│   │   ├── investor-rollup.ts    # POST /jobs/investor-rollup (MONEY-789 B4)
│   │   └── dead-letter.ts       # POST /jobs/dead-letter — consumes dead-letter-${ENV}; ALWAYS 200 (MONEY-1204)
│   └── processors/
│       ├── dead-letter-consumer.ts       # DLQ I/O shell: dedupe claim + log + founder notification (MONEY-1204)
│       ├── dead-letter-consumer-logic.ts # PURE DLQ shaping: redact, truncate, attribute hoisting (MONEY-1204)
│       ├── pairing.ts            # Trade pairing business logic
│       ├── import.ts             # CSV import business logic
│       ├── sync.ts               # Broker sync business logic
│       ├── instrument-sync.ts    # Instrument master data sync
│       ├── price-sync.ts         # Price data backfill & quote refresh
│       ├── sector-enrichment.ts  # Sector/industry enrichment via Yahoo
│       ├── mf-sync.ts            # AMFI NAV sync (delegates to @usemoney/core)
│       ├── mf-metadata-sync.ts   # MF metadata enrichment (delegates to @usemoney/core)
│       ├── peers-sync.ts         # Derived StockPeers rebuild (delegates to @usemoney/services)
│       ├── research.ts           # AI research job processing
│       ├── document-process.ts   # Document extraction & report generation
│       ├── stock-document-extract.ts      # Document AI / pdf-parse extraction I/O (MONEY-783)
│       ├── stock-document-extract-logic.ts # PURE extract query/path helpers (MONEY-783, unit-tested)
│       ├── roast.ts              # Portfolio roast analysis
│       ├── comparison.ts         # Deep stock/MF comparison (MONEY-553)
│       ├── investor-rollup.ts    # Nightly investor rollup I/O (MONEY-789 B4)
│       └── investor-rollup-logic.ts  # PURE rollup math (MONEY-789 B4, unit-tested)
├── report-templates/             # PDF report templates (React/JSX)
│   ├── index.ts                  # Template registry
│   ├── portfolio-statement.tsx   # Portfolio statement report
│   ├── risk-report.tsx           # Risk analysis report
│   ├── tax-report.tsx            # Tax report
│   └── styles.ts                 # Shared template styles
├── __tests__/                    # Worker tests
│   ├── auth-middleware.test.ts   # OIDC middleware tests
│   └── lib/
│       ├── notifications.test.ts
│       └── pull-subscriber.test.ts
├── Dockerfile                    # Docker build config (Cloud Run Service)
├── cloudbuild.yaml               # Parameterized Cloud Build
├── cloudbuild.qa.yaml            # QA Cloud Build
├── cloudbuild.prod.yaml          # Production Cloud Build
├── scripts/
│   ├── deploy.sh                 # Cloud Run Service deployment (local Docker - prefer setup-infra.sh)
│   ├── build.sh                  # Local Docker build
│   ├── setup-pubsub.sh           # Create Pub/Sub topics & subscriptions (43 topics + dead-letter)
│   ├── gcp-setup.sh              # One-time GCP setup (APIs, SA, IAM, secrets)
│   └── seed.sh                   # DEPRECATED - forwards to scripts/seed-env.sh
└── package.json
```

**Root-level scripts (related to workers):**

```
scripts/
├── ops/setup-infra.sh            # Single-command infra setup: db push + pubsub + scheduler + deploy
├── ops/setup-scheduler.sh        # Creates Cloud Scheduler jobs for automated syncs (qa/prod/all)
└── seed-env.sh                   # Multi-environment database seeding (qa/prod/all)
```

---

## D1 tile builder — MONEY-1467 (data-platform A2)

`tile-build-d1-{in,us}-{env}` — Cloud Run JOBS (`scripts/jobs/tile-build-d1.ts`,
bundled as `dist/tile-build-d1.js` by `workers/tsup.config.ts`). They build the
immutable D1 tiles `apps/market-data` serves from `/udf/history`.

**A JOB, not a Pub/Sub lane.** A full India build is ~24,000 active listings x a
five-year `DailyPrice` range — hours, against Pub/Sub's 600s ack deadline, which
is its MAXIMUM. Past it Pub/Sub does not wait, it REDELIVERS, so a second
builder starts on the same listings and both write the same objects.

**IT NEVER CALLS YAHOO.** `DailyPrice` is already a merged table with
provenance — `BHAVCOPY` where bhavcopy-sync parsed the exchange file, `YAHOO`
only where `yahoo-price-service` gap-filled — with precedence enforced by
`mayWritePriceSource` (MONEY-1175). A builder that fetched would be a SECOND
writer racing the first on a table whose whole design is one declared authority
order. What it does instead is COUNT: `yahoo_fill_sessions` per listing, into
the manifest and out as `stockbook.tiles.yahoo_fill_sessions`. **A rising value
is a bhavcopy-sync defect, not a tile defect** — a Yahoo-filled bar renders
identically to an exchange one, so without this counter nobody would ever see
the exchange feed going dark for one instrument.

**THE SCHEDULE FOLLOWS THE PRODUCER, and the A2 brief got both times wrong.**
It specified 19:45 IST "after bhavcopy-sync" (which runs at **21:00**) and 06:30
IST "after us-eod-sync" (which runs at **11:00**). Both are BEFORE the job they
claim to follow, so every build would read the previous session and write a tile
that is valid, complete, internally consistent and one session stale — the
MONEY-1194 defect exactly. Corrected, and per-env for India because QA replays
prod's archived bhavcopy 30 minutes later than prod parses it:

| job                | prod                  | qa                    |
| ------------------ | --------------------- | --------------------- |
| `tile-build-d1-in` | **21:45** IST Mon–Fri | **22:15** IST Mon–Fri |
| `tile-build-d1-us` | **11:45** IST Tue–Sat | same                  |

`corporate-actions-sync-daily` (04:30 IST) is genuinely before both.

**TILES GO TO THE LAKE BUCKET.** `gs://stockbook-lake-{env}/tiles/{IN,US}/d1/`,
never the content bucket — the `tiles/` prefix routes there and
`bucketForPrefix` is the machine-checked statement of it. `LAKE_ENV` must be set
on the JOB (a job does NOT inherit the service env block); without it
`initTileStore()` registers nothing, and the job refuses to run under `--apply`
rather than walking every listing and storing nothing.

**Idempotent.** `rebuildReason` skips a listing whose source has not advanced,
and names WHY when it does rebuild — `no-entry`, `source-advanced`,
`policy-changed`, `format-changed`. A closed year tile is written ONCE and
rewritten only on a policy or format change, so an ordinary night does not
rewrite a decade of immutable objects for one new session.

Provision with `./scripts/ops/setup-tile-build-job.sh {qa|prod}`, and re-run it
after every workers deploy — a job PINS its image at provision time.

## `POST /jobs/us-filing-events` — the events door (MONEY-1507 C1, MONEY-1520)

The door `services/us-fundamentals` (Python) produces events through, after it
claims a filing.

### It was `POST /internal/events`, and it 404'd every call for its whole life

The producer POSTed here directly, with a correct URL, a correct OIDC audience
and correct IAM. **It never once reached this service.** `stockbook-workers-{env}`
carries `run.googleapis.com/ingress: internal` and `us-fundamentals-{env}` has
no VPC egress, so the request left over the public internet and Cloud Run
refused it AT THE EDGE — before Hono, before the auth middleware.

**The status code is the proof.** `/internal/*` was gated by `jobsAuth`, which
answers **401** on a missing or invalid token and has no 404 path at all. A 404
therefore means the request never got as far as the gate. An internal-ingress
service answers an external caller 404 precisely so it does not reveal that it
exists. Meanwhile `instrument_events` held 4,019 rows and **not one** was
`SEC_EDGAR`, while `[job-outcome]` reported `failed: 0` every minute.

`route-registration-coverage.test.ts` was green throughout, and correctly so —
the route WAS mounted, the module WAS in the built artifact, the URL WAS the
service's own `status.url`. Every fact it checks was true. **A route-mounting
test cannot see a transport that is refused before it arrives**, which is why
`__tests__/us-filing-events-transport.test.ts` exists and asserts different
things: that the PYTHON topic constant names a `/jobs/` route that exists (a
join across the LANGUAGE seam), that the topic has a push subscription, that no
producer source addresses `stockbook-workers` or holds a `*.run.app` URL, and —
as the premise it all reasons from — that this service really is
internal-ingress in both specs.

### So it is a Pub/Sub push consumer now

**PROVISIONING IS REQUIRED AND NOTHING WILL TELL YOU IT WAS SKIPPED.** Measured
against live `stock-book-483718` on 2026-09-22: `us-filing-events-prod` and
`us-filing-events-prod-push` were the only two of 65 declared topics and
subscriptions missing (qa was missing three). Run
`./workers/scripts/setup-pubsub.sh {env}` **after** the workers deploy and
**before** the us-fundamentals deploy — the route must exist before the
subscription points at it. Until then `edgar-detect-minutely-prod`, enabled at
`* * * * *`, errors on every run.

Producer publishes to `us-filing-events-{env}`; the subscription pushes to
`/jobs/us-filing-events`. Pub/Sub push is not external traffic, which is the
entire reason the ~55 sibling job routes reach this same service without
trouble. **VPC egress and relaxing ingress were both considered and REJECTED**
on MONEY-1520 — the first adds a connector and its standing cost to a service
that otherwise needs no VPC, the second weakens a deliberate boundary in front
of an unauthenticated-writer risk.

**The path segment MUST equal the topic base name.** `setup-pubsub.sh` builds
every worker push endpoint as `${SERVICE_URL}/jobs/${BASE_TOPIC}` and
`route-registration-coverage.test.ts` joins `BASE_WORKER_TOPICS` against the
`/jobs/*` mounts in both directions, so a bespoke endpoint would be a second
convention no guard checks.

**The file and symbol names did NOT change** (`routes/internal-events.ts`,
`internalEventsRoute`, `processors/internal-events{,-logic}.ts`). Nothing about
the REQUEST moved — same zod contract, same body, and the route already decoded
a push envelope through `parsePubSubMessage` — so renaming three modules and
their tests to match a path would be churn with no behaviour in it.

**The gate did not move either.** `/jobs/*` carries the same
`createJobsAuthMiddleware` the route sat behind before. The `/internal/*`
registration is KEPT even though it now guards nothing: the route it used to
cover WRITES to `instrument_events`, the collection C4's alert evaluator reads,
so an unauthenticated writer there could notify every user holding a stock
(MONEY-288 one route family over). A standing deny on the prefix costs one
registration and means the next `/internal/…` route is gated from its first
commit.

`/jobs/*` also brings `pubsubDedupeMiddleware`, which `/internal/*` did not.
That is a BONUS and not the argument: `publishEvents` upserts on a deterministic
`eventId`, so a duplicate delivery is free.

**CORRECTED (MONEY-1514 review).** This used to claim the dedupe also stops a
redelivery re-stamping `observedAt`. It does not. Dedupe skips a duplicate of an
**ACKed** message (`SKIP_COMPLETED`); the **500-NACK** retry `ackStatusFor`
introduces is granted `RUN` by `reclaim_after_failure`. Since `eventSilverKey`
includes `observed_at`, a re-stamp would make the lake sink append a SECOND
`instrument_event` row, indistinguishable from a real enrichment. The handler
therefore takes `observedAt` from the envelope's `publishTime`, which is stable
across redeliveries; a direct body falls back to the wall clock.

**Superseded twice on 2026-09-23.** MONEY-1532: each filing's own payload
`observedAt` (the SEC claim's `detectedAt`) now wins. It must be a zoned ISO
instant, after 1993, and no more than 5 min past `publishTime`; an invalid one
falls back per filing, never failing the batch. `publishTime`, then the wall
clock, are only the fallback. MONEY-1531: `publishEvents` writes `observedAt`
on the CREATE only, so no re-delivery or re-emission can move a stored row's
first sighting any more, whatever this route passes.

### STATUS CODES — Pub/Sub ACKs only on 2xx, so a 2xx must mean "done"

**200 only when every event in the batch is in Mongo.** The route used to answer
200 with `success: false` for a partially-written batch; under a direct POST
that was a number the caller logged, but under a push subscription it is an ACK
and the failed events are gone with nothing to redeliver them. `ackStatusFor`
(in `internal-events-logic.ts`, so a test can drive the decision rather than a
source scan guessing at it) returns **500** when `failed > 0`. A retry is free —
the upsert is keyed on `eventId`.

**400 on an invalid request**, which NACKs and parks the message on
`dead-letter-{env}` after five attempts, **with its payload**. That is the
point: the DLQ is this lane's retry channel, deliberately unlike
`/jobs/us-filing-insight`, which ACKs 200 on every path because its leaves spend
PAID model calls and its retry channel is an `insightStatus` column. Here the
unit of work is a cheap idempotent upsert, so redelivery costs nothing and
parking preserves the evidence.

### The request carries FACTS, not events

`accession`, `cik10`, `form`, `items`, `acceptedAt`, `filedAt` — the
`us_filings` row the detector just wrote. The event id, the event type, the
severity ladder and the CIK -> listing join all happen HERE, in
`internal-events{,-logic}.ts` + `@usemoney/core/events/event-types`. A Python
copy of any of them would be a second spelling of a rule that has to agree
forever and will not (MONEY-1255's `mimeType`, MONEY-979's concept vocabulary).

**The CIK resolves through `UsInstrument.cik`**, not `UsFiler` / `UsCusipMap` as
the C1 brief says — neither of those tables HAS a listing id. `UsFiler` is read
for the company NAME only. A CIK with no listing is NOT an error: the event is
stored with `listingId: null` and `confidence: 0.5`, and C3's linkers fill it in.

### `us-filing-events` is NOT the topic `events.service.ts` declines to build

`packages/services/src/events.service.ts` records three measured reasons for not
creating an `instrument-event-{env}` topic. **That decision is about the LAKE
SINK** — the silver append — and none of its reasons transfer here: this hop
ends in a Mongo upsert (not BigQuery, which `stockbook-api@` cannot write), it
HAS a consumer, and the losslessness concern runs the other way, since the
transport it replaces lost 100% of its messages silently. The silver append is
unchanged: `scripts/jobs/event-lake-sink.ts`, a Cloud Run JOB running as
`lake-writer-{env}@`, draining Mongo by watermark.

---

## Job Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Web App (Vercel)                          │
│  Server Action → Pub/Sub.publish(jobData)                   │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│               Google Cloud Pub/Sub                          │
│  Topics: trade-pairing | csv-import | broker-sync           │
│          instrument-sync | price-sync | sector-enrichment   │
│          mf-sync | mf-metadata-sync | stock-research        │
│          document-process | portfolio-roast                  │
│          comparison-analysis                                 │
│  Push Subscriptions → Cloud Run Service                     │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│           Workers (GCP Cloud Run Service)                   │
│  Hono HTTP Server (port 8081)                               │
│                                                              │
│  User-scoped jobs:                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐        │
│  │  /jobs/      │  │  /jobs/     │  │  /jobs/      │        │
│  │trade-pairing │  │ csv-import  │  │ broker-sync  │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬───────┘        │
│         │                │                │                  │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼───────┐        │
│  │  Processor  │  │  Processor  │  │  Processor   │        │
│  │  (pairing)  │  │  (import)   │  │  (sync)      │        │
│  └─────────────┘  └─────────────┘  └──────────────┘        │
│                                                              │
│  System-level jobs (no userId):                             │
│  ┌─────────────────┐  ┌────────────────┐                    │
│  │  /jobs/          │  │  /jobs/        │                    │
│  │instrument-sync   │  │ price-sync     │                    │
│  └──────┬──────────┘  └──────┬─────────┘                    │
│         │                    │                               │
│  ┌──────▼──────────┐  ┌──────▼─────────┐                    │
│  │  Processor      │  │  Processor     │                    │
│  │  (instrument)   │  │  (price)       │                    │
│  └─────────────────┘  └────────────────┘                    │
│                                                              │
│  ┌──────────────────┐  ┌───────────────────┐                │
│  │  /jobs/           │  │  /jobs/            │                │
│  │sector-enrichment  │  │ mf-sync            │                │
│  └──────┬───────────┘  └──────┬────────────┘                │
│         │                     │                              │
│  ┌──────▼───────────┐  ┌──────▼────────────┐                │
│  │  Processor       │  │  Processor        │                │
│  │  (sector)        │  │  (mf-sync)        │                │
│  └──────────────────┘  └───────────────────┘                │
│                                                              │
│  ┌──────────────────┐                                       │
│  │  /jobs/           │                                       │
│  │mf-metadata-sync   │                                       │
│  └──────┬───────────┘                                        │
│         │                                                    │
│  ┌──────▼───────────┐                                        │
│  │  Processor       │                                        │
│  │  (mf-metadata)   │                                        │
│  └──────────────────┘                                        │
│                                                              │
│  AI-powered jobs (user-scoped):                             │
│  ┌────────────────┐  ┌──────────────────┐                   │
│  │  /jobs/         │  │  /jobs/           │                   │
│  │stock-research   │  │ portfolio-roast   │                   │
│  └──────┬─────────┘  └──────┬───────────┘                   │
│         │                    │                               │
│  ┌──────▼─────────┐  ┌──────▼───────────┐                   │
│  │  Processor     │  │  Processor       │                   │
│  │  (research)    │  │  (roast)         │                   │
│  └────────────────┘  └──────────────────┘                   │
│                                                              │
│  ┌──────────────────┐                                       │
│  │  /jobs/           │                                       │
│  │document-process   │                                       │
│  └──────┬───────────┘                                       │
│         │                                                    │
│  ┌──────▼───────────┐                                       │
│  │  Processor       │                                       │
│  │  (document)      │                                       │
│  └──────────────────┘                                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Message Format

Pub/Sub push subscriptions deliver messages as HTTP POST with this envelope:

```json
{
  "message": {
    "data": "<base64-encoded JSON>",
    "messageId": "123456",
    "publishTime": "2026-01-30T00:00:00Z"
  },
  "subscription": "trade-pairing-push-qa"
}
```

The `data` field is base64-decoded and parsed as JSON into the job-specific
message type.

### Pairing Job Data

```typescript
{
  jobId: string;
  userId: string;
  batchId?: string;
}
```

### Import Job Data

```typescript
{
  jobId: string;
  userId: string;
  content?: string;         // Inline CSV (small files)
  fileUrl?: string;          // GCS URL (large files)
  brokerFormat: string;
  fileType: "csv" | "xlsx";
  fileName?: string;
  brokerConnectionId?: string;
  linkToManual?: boolean;
}
```

### Sync Job Data

```typescript
{
  jobId: string;
  userId: string;
  brokerConnectionId?: string;
  broker?: string;
  dataTypes?: ("holdings" | "positions" | "trades" | "mutualFunds")[];
  isScheduled?: boolean;     // True for Cloud Scheduler-triggered bulk syncs (userId="*")
}
```

### Instrument Sync Data (system-level, no userId)

```typescript
{
  exchanges?: string[];       // Optional filter, default: all supported
  forceFullSync?: boolean;    // Re-sync even if synced today
}
```

### Price Sync Data (system-level, no userId)

```typescript
{
  instrumentIds?: string[];   // Optional subset, default: all active
  dateRange?: { start: string; end: string };
  source?: "YAHOO" | "ZERODHA";
}
```

### Sector Enrichment Data (system-level, no userId)

```typescript
{
  // Defaults below are DEFAULT_SECTOR_* in
  // workers/src/processors/sector-enrichment-logic.ts — all three were wrong
  // here until MONEY-1238 (100/["NSE"]/2000). The delay one mattered: at the
  // documented 2000ms a 500-row batch would be 1000s, which cannot fit the
  // 600s Pub/Sub ack ceiling at all, so anyone reasoning about throughput from
  // this block reached the wrong conclusion about whether the job overruns.
  batchSize?: number;         // Max instruments per run (default: 500)
  exchanges?: string[];       // Optional filter, default: ["NSE", "BSE"]
  forceReEnrich?: boolean;    // Re-enrich even if sector is already set
  delayMs?: number;           // Delay between Yahoo calls (default: 500)
}
```

### MF Sync Data (system-level, no userId)

```typescript
{
  forceFullSync?: boolean;    // Force re-sync even if synced today
}
```

### MF NAV Propagate Data (system-level, no userId) — MONEY-1074

```typescript
{
  batchSize?: number;         // Rows per keyset page (default: 500)
}
```

Copies fresh `MutualFundMaster` NAVs into user `MutualFund` rows so the dashboard
MF value/return reflect current NAV (user rows' `currentNav` was set once at
creation and never refreshed). Delegates to `propagateMfNavToUserFunds`
(@usemoney/services), backed by the pure `buildMfNavPatch` decision (never zeroes
a row on a missing/bad master NAV; idempotent fixpoint). Reads ONLY our own DB
(no rate-limited upstream), so it runs on BOTH envs — it is deliberately NOT in
the scheduler's `PROD_ONLY_JOBS`. Daily Cloud Scheduler trigger
(`mf-nav-propagate-daily`, 11:45 PM IST, after `mf-sync`).

### Peers Sync Data (system-level, no userId) — MONEY-1145

```typescript
{
  exchanges?: string[];       // reserved; the job is currently whole-universe
}
```

`stock_peers` had **0 rows platform-wide** — the only writer was a StockSage
research pass, so the stock-detail Peers tab was empty by construction for every
symbol since it shipped. This job derives peers from our OWN data
(`InstrumentMapping` + `StockRatios` + `LatestQuote`) instead of scraping, so it
needs no upstream, has no rate limit, and — like `mf-nav-propagate` — runs on
BOTH envs and is deliberately NOT in the scheduler's `PROD_ONLY_JOBS`.

Selection is pure and unit-tested (`peer-selection-logic.ts` in
`@usemoney/core/market-data`): same exchange (cross-exchange would hand a
dual-listed company its own other listing as the nearest peer), same
`(sector, industry)` when that group has >= 5 members else widening to the
sector, ranked by **log-scale** market-cap proximity (caps span 4+ orders of
magnitude, so linear distance collapses every large-cap's peer set onto the
other giants), ties broken on symbol for determinism. Instruments carrying the
`SECTOR_SKIPPED` sentinel `"N/A"` — 14,893 of 22,153 — are skipped rather than
bucketed together.

Empty results ARE written (`peerCount: 0`), so "no row" means _not computed yet_
and a 0-count row means _computed, genuinely none_ — the distinction whose
absence let the tab sit empty unnoticed. Daily Cloud Scheduler trigger
(`peers-sync-daily`, 11:15 PM IST, after sector-enrichment and price-sync).

Measured on QA: 6,992 rows written in 168s against a 600s push ack deadline.

### MF Metadata Sync Data (system-level, no userId)

```typescript
{
  batchSize?: number;         // Max funds to process per run (default: 500)
  delayMs?: number;           // Delay between per-fund DB writes in ms (default: 1000).
                              // NOT upstream pacing: the AMFI provider fetches its three
                              // whole-universe files ONCE and memoises them at module scope.
                              // ~82% of the 600s ack deadline at batchSize 500 — the first
                              // lever if this job has to drain faster (MONEY-1409).
  forceReEnrich?: boolean;    // Re-enrich all funds, even if recently synced
}
```

### Research Job Data

```typescript
{
  jobId: string;
  userId: string;
  sessionId: string;
  query: string;
  skill?: string;
  symbols?: string[];
  mode?: "fast" | "advanced";
}
```

### Portfolio Roast Data

```typescript
{
  jobId: string;
  userId: string;
  sessionId: string;
  mode: "overall" | "broker";
  broker?: string;
  assetType: "stocks" | "mf" | "all";
}
```

### Comparison Data (MONEY-553)

```typescript
{
  jobId: string;
  userId: string;
  sessionId: string;        // ComparisonSession.sessionId
  kind: "stock" | "mf";     // selects the skill: stock→multi-comparison, mf→mf-comparison
  depth: string;            // "deep" | "comprehensive" | "advanced" | "custom"
  symbols: string[];
  exchange?: string;        // optional hint for stock comparisons
}
```

### Document Process Data

```typescript
{
  jobId: string;
  userId: string;
  documentId: string;
  action: "extract_text" | "generate_report" | "fetch_url" | "fetch_nse";
  url?: string;               // For fetch_url action
  reportType?: "tax" | "risk" | "portfolio_statement";  // For generate_report action
  reportParams?: Record<string, unknown>;  // Extra params for report generation (fy, etc.)
}
```

### Fund Composition Sync Data (system-level, no userId)

```typescript
{
  batchSize?: number;         // Max funds to process per run (default: 50)
  fundTypes?: ("ETF" | "MF")[];  // Fund types to process (default: ["ETF", "MF"])
  minAum?: number;            // Min AUM in crores for MFs (omit for all)
  refreshStale?: boolean;     // Re-extract stale compositions (>90 days)
}
```

### Stock Document Extract Data (system-level, no userId) — MONEY-783

```typescript
{
  symbols?: string[];         // Specific symbols (empty = all PENDING PDFs)
  docTypes?: string[];        // Only extract specific doc types
  force?: boolean;            // Also re-run FAILED docs (default: only PENDING)
  batchSize?: number;         // PAGE SIZE per run (default: 500, MONEY-1255)
  chainDepth?: number;        // MONEY-1255 self-chain depth; 0 on a scheduler trigger
}
```

#### MONEY-1255 — the queue drained LIFO at 50/day, and 1,211 rows were unreachable

Measured on prod 2026-08-26: `stock_documents` held **43,105** rows, **36,001**
of them `PENDING`. Three defects, all in this one job.

**1,211 rows could never be SELECTED.** `mimeType` is written from the raw
`content-type` RESPONSE HEADER, which is a media type PLUS PARAMETERS, and
`buildExtractQuery` matches it EXACTLY. So `application/pdf;charset=UTF-8` was
stored, never selected, and sat PENDING for the life of the table — while
`inferExtension` named the GCS object with a SUBSTRING test, so the FILE was
correctly called `.pdf` the whole time. A right filename beside an unreachable
row, which is why nothing looked broken. Beside it, **1,210** `text/html` (in
FOUR spellings), `audio/mpeg` and `application/zip` rows sat PENDING queued for
an extractor that will never read them.

The rule now lives ONCE, in `@usemoney/core/market-data/doc-mime` (a zero-import
pure leaf), because there are TWO writers of this column from a raw header and
they sit in packages that cannot import each other: this processor's
`storeScreenerDoc` and `packages/research/src/data-sources/stock-document-fetcher.ts`.
Both call `normalizeDocMimeType` for the value and `initialProcessingStatus` for
the status; `inferExtension` and the extract query read the same rule. Non-PDFs
are created **`UNSUPPORTED`** — a new terminal status in `docs-section-logic.ts`,
deliberately NOT `FAILED`, because `force:true` re-runs FAILED and would put
1,210 guaranteed no-ops into every forced pass. `scripts/data/repair-stock-document-queue.ts`
clears what already accumulated; it imports the same helpers, so the repair and
the writers cannot disagree.

**The queue drained NEWEST-FIRST at 50/day.** `orderBy: { fetchedAt: "desc" }`
with no cursor, `{"batchSize":50}` from the scheduler, against 34,790 PDFs and a
weekly sync that adds thousands. Newest-first over a growing queue does not
delay the old rows — it pushes them down on every cycle and never reaches them
(MONEY-1211, 681 of 781 symbols). ~2 years to drain even with no new arrivals.
Now `EXTRACT_ORDER_BY = { fetchedAt: "asc" }`.

**A bigger batch is NOT the lever** — see the 600s ceiling section above. The run
is bounded by `RUN_TIME_BUDGET_MS = 420_000`, checked BETWEEN documents:

```
 600s  Pub/Sub ack deadline (Pub/Sub's MAXIMUM; Cloud Run's 3600s never binds)
-420s  RUN_TIME_BUDGET_MS — no NEW document is started past this
------
 180s  headroom, which absorbs:
  ~60s   the one document already in flight (a ~30-page cross-region Document
         AI call that degrades, + a pdf-parse fallback, + a sidecar upload)
   ~1s   the findMany
   ~1s   reportJobOutcome + the chain publish
```

Same 420s `mf-nav-backfill` uses, and lower than `xbrl-sync`'s 480s on purpose:
that job's per-item cost is a fixed 600 ms delay plus one download, so its
overshoot is bounded and small; here a single Document AI call carries no
client-side timeout, so the overshoot is the lumpy term. Overrunning the deadline
does not make a run slow — Pub/Sub redelivers and a SECOND copy starts on the
same page.

**It SELF-CHAINS**, bounded by `MAX_CHAIN_DEPTH = 20`. Each published follow-up
carries `chainDepth + 1` and `shouldChainAnotherBatch` refuses once the next
depth would REACH the ceiling — so a chain is at most 20 messages **whatever the
queue does**. That bound is the termination proof and it never consults the
database; the other three stop conditions (short page, nothing left PENDING,
`force`) can only end it sooner. `force` never chains at all: it widens the
selection to PENDING+FAILED, so a deterministically-failing document is
re-selected on every link and there is no fixpoint to reach.
20 x 420s ≈ 2h20m from the 22:00 IST trigger; ~1,400 documents a night at a
pessimistic 6 s/document, so the 34,790-PDF backlog clears in ~25 nights.

**`reportJobOutcome` moved into the `finally`**, and that was a PREREQUISITE
rather than tidying. It used to sit below the empty-queue early return, so an
idle night emitted NO metric — and `apply-monitors.sh` now creates a freshness
monitor for this job with `notify_no_data: true`, which would have gone red the
moment the backlog finished draining. An idle run now reports 0/0, which the
clamped-difference query reads as healthy.

**The monitor comment was FALSE.** `apply-monitors.sh` excluded this job saying
it was "CHAINED, not scheduled", while `setup-scheduler.sh` has carried
`stock-document-extract-daily` on `0 22 * * *` since MONEY-783, on BOTH envs (it
is not in `PROD_ONLY_JOBS`). The daily job that feeds the entire RAG corpus had
no freshness monitor. It now has one, at 36h. `stock-document-embed` stays
unmonitored, but VERIFIED rather than assumed: it has no scheduler entry at all
and its only publisher is `triggerEmbedPass`.

NSE/Screener PDFs land as `StockDocument` rows with `processingStatus:"PENDING"`
and `textContent:null`; the embed worker needs `READY` + non-null `textContent`,
so this job is the missing link. Per doc (never aborts the batch): mark
`PROCESSING`, try Google Document AI (`lib/docai.ts`, layout-aware OCR, ~30pp
online cap, degrades to null — never throws), fall back to `pdf-parse` over the
downloaded bytes, then mark `FAILED` (< 50 chars) or `READY`. **NO SCHEMA
CHANGE:** over-cap docs (> `MAX_TEXT_LENGTH`) store the FULL text in a derived
GCS sidecar (`{gcsPath}.extracted.txt`) and only a capped preview in
`textContent`; the embed worker probes that sidecar so it chunks the whole
document. ALWAYS chains a `STOCK_DOCUMENT_EMBED` job — from a `finally`, so
it fires on the empty-queue path too (MONEY-1238). This sentence used to say
"if anything was extracted", which described the code exactly: the publish
sat below an early return taken whenever no PENDING **PDF** existed, and it
is the ONLY trigger for the embed job in the repo — there is no scheduler
entry. So on any day the text-only sync wrote READY documents and the PDF
queue happened to be empty, the RAG corpus silently stopped ingesting. Daily
Cloud Scheduler trigger (`stock-document-extract-daily`, 22:00 IST); also
chained from `stock-document-sync` (replacing the old direct embed chain — the
extract job no-ops when there are no PENDING PDFs and chains embed itself). The
worker WORKS before the Document AI processor is provisioned
(`documentAiReady()` false → straight to pdf-parse). Pure query/path helpers are
in `stock-document-extract-logic.ts` (unit-tested); the route ACKs 200 even on a
throw.

#### MONEY-784 (P3b) — ingestion breadth

The `StockDocType` union (`@usemoney/research/data-sources/stock-document-paths`)
gained four NSE announcement categories beyond annual reports:
`investor_presentation`, `credit_rating`, `press_release`,
`earnings_call_intimation`.

- **Broadened NSE ingestion.** `stock-document-sync` now calls
  `fetchCategorizedAnnouncements` (which runs the pure
  `categorizeNseAnnouncement(subject, description)` mapper from
  `nse-filings-logic.ts`) instead of the annual-report-only filter. Each useful
  announcement is bucketed into its docType (noise → dropped), capped at the
  top 5 per category, and stored as a PENDING PDF — flowing through the same
  extract → embed chain as before. (`fetchAnnualReports` / `filterAnnualReports`
  are retained for back-compat but no longer called by the sync.)
- **Per-docType chunkers.** `stock-document-embed` dispatches via
  `chunkByDocType(docType, text, symbol)` (in `stock-document-embed-logic.ts`):
  `concall_transcript` → speaker-turn chunking (`chunkConcallTranscript`),
  `annual_report` → AR-heading chunking (`chunkAnnualReport`), everything else →
  the section-aware `chunkFinancialText`. All chunkers stay pure and keep the
  `{SYMBOL} - {section}` prefix convention; each falls back to
  `chunkFinancialText` when its target structure isn't present.
- **Citations on text-statement docs.** The Tickertape `financial_statement`
  and Screener `screener_financials` upserts now set `sourceUrl`
  (`buildTickertapeUrl(symbol, sid)` / `buildScreenerUrl(symbol)` in
  `stock-document-sync-logic.ts`) so their embedded chunks carry a clickable
  citation (MONEY-670 propagates `sourceUrl` into chunk metadata).
- **Deferred TODOs (out of scope for this ticket):** persisting the
  Screener-scraped structured 10Y financials into `StockFinancials`. The other
  one — "the sync self-pagination regression" — is CLOSED by MONEY-1255 below.

#### MONEY-1255 — the batch never rotated, and 76.3% of equities had no document

Measured on prod 2026-08-26: **15,866 of 20,804** active equity rows carry no
document of any kind; only **2,614 of 18,331** distinct active symbols have one.

The selection was `orderBy: { analysisCount: "desc" }` with no tiebreak, and
`analysisCount` is **0 on all 10,444 active NSE equities** — this repo measured
that itself and wrote it down in `news-sync-logic.ts`. A sort key constant
across the population is not a sort: Mongo resolved the same arbitrary order
every trigger, nothing in the run mutated the key, and the same ~250 symbols
were re-synced forever. MONEY-1211 for the third time. The old test suite
ASSERTED it as intended behaviour ("Re-running re-processes the SAME head
(idempotent), never the tail").

Five fixes, all in `stock-document-sync{,-logic}.ts`:

- **Rotation.** `[{ documentsSyncedAt: "asc" }, { symbol: "asc" }]`
  (`buildDocumentSyncOrderBy`), and every VISITED row is stamped — four sites:
  the normal loop, the symbol-level `catch`, the unresolvable-instrument branch,
  and the BSE-only skip; plus the excluded-symbol rows before the loop. Stamping
  only on a WRITE is how the sibling `annual-reports-sync` stalled: a symbol
  that legitimately has no documents keeps its stale marker and re-occupies the
  head forever. **The marker is in the `orderBy` and NEVER in the `where`** —
  `documentsSyncedAt` is ABSENT (not null) on every pre-existing row, so
  `{ documentsSyncedAt: null }` matches ZERO rows (MONEY-1050 / 1205 / 1234 /
  1236). Ordering has no such hazard: Mongo sorts a missing field lowest, so an
  unstamped row leads the page, which is exactly right.
- **A wall clock, not a bigger batch.** `249 x 2,000ms` inter-symbol sleep plus
  `250 x 3,000ms` of Screener self-throttle is **1,248s against a 600s ack
  deadline**, before one HTTP round trip — the run was arithmetically incapable
  of finishing, and each redelivery restarted at index 0.
  `SYNC_RUN_TIME_BUDGET_MS = 300_000` is checked before every new SYMBOL, LEG
  and DOCUMENT DOWNLOAD; between-symbols alone would leave an in-flight term of
  ~960s (5 categories x 5 PDFs x a 30s timeout), larger than the deadline it
  sits inside. Headroom absorbs one worst unit — a Screener scrape carrying the
  full 429 ladder, 178s — plus ~8s of tail, leaving ~116s spare.
- **Self-chaining**, bounded by `MAX_SYNC_CHAIN_DEPTH = 20`. That bound is the
  termination proof and consults no database, clock or queue. Five other stop
  conditions only end it sooner, one of them new: a run that **circuit-broke on
  a Screener 429 does not chain**, because `API_LIMITS` are PER RUN and a fresh
  link re-arms the breaker straight back into the tarpit (MONEY-853).
- **BSE-only symbols are counted, not vanished.** The page selects NSE **and**
  BSE, but `select: { symbol: true }` discarded the exchange and the loop
  hardcoded `"NSE"`, so a BSE-only symbol consumed a slot and was dropped with
  no log and no counter. It is now counted in the outcome and it rotates.

  This bullet used to end "no producer in this repo can give a BSE-only company
  an `annual_report` / `quarterly_result` / `financial_statement`. Closing that
  gap is a new BSE ingest, not a fix to this job." **Both halves turned out to
  be wrong, and in the same ticket.** The documents were reachable from
  screener.in all along — we simply had no way to name the company's page (A2
  section below) — and the quarterly gap was not a missing ingest but a dead
  one: `bse-announcements-sync` had written ZERO rows since inception, so
  "reaches those symbols and writes only `corporate_filing`" described a job
  that wrote nothing at all. Worth keeping as a caution about the shape of the
  claim: "no producer can" was inferred from what our NSE-keyed producers do,
  and never tested against what the sources actually publish.

- **Counts are WRITES, and the health condition is leg-aware.** Every
  per-source counter was incremented BEFORE the call it counted, so a source
  that 403s every request still reported a full number. And the condition read
  `apiCalls.nse === 0`, which is true on EVERY healthy run of
  `stock-document-sync-tickertape-daily` (its `docTypes:["financial_statement"]`
  gates both NSE legs off by design) — a permanently-asserted alarm, which never
  checked `screener` at all. `describeSyncShortfall` reports only a source the
  run ENABLED, counting `run.wrote.*`, and `transportFailures` is now passed so
  `job-outcome.ts`'s upstream-failure branch is reachable.

**THE "TICKERTAPE" LEG MAKES NO NETWORK CALL.** `getOrFetchFinancials` is a
pure Prisma read of `stock_financials`; `TICKERTAPE_BASE` is used only by
`buildTickertapeUrl` to fill the `sourceUrl` column. `TT=250` meant 250 database
lookups and `TT=0` could never occur, so this job is NOT the MONEY-1228 probe
for whether `www.tickertape.in` blocks our egress — the root `CLAUDE.md`
paragraph that said it was has been retracted.

#### MONEY-1255 — `bse-announcements-sync` had written ZERO rows, ever

Measured on prod 2026-08-26: `stock_documents` where `docType:
"corporate_filing"` = **0**, newest `fetchedAt` = NONE. It ran nightly at 21:30
IST and exited 0 every time. **Two independent defects, stacked** — fixing
either alone leaves the job silently broken.

**1. The query matched nothing.** The client sent `strCat=-1`, reading `-1` as
"every category" the way an empty `strScrip` means "every scrip". `strCat` takes
a category NAME and has no "all" value. BSE answered **200 with a body of `{}`**
— a working endpoint correctly reporting that a filter matching nothing matched
nothing — the page walk read zero rows as "no more pages", and the job logged
"Fetched 0 announcements".

Our own repo recorded this and did not act on it.
`docs/reference/exchange-archive-probe.json` carries the `strCat=-1` probe at
verdict EMPTY / 2 bytes for BOTH a recent window and a 2011 window;
`exchange-archive-ranges.md` says "param set NOT confirmed". The correction —
"strCat takes the category NAME, not -1" — was applied to
`scripts/data/probe-exchange-archives.ts` and never to the file that runs
nightly. Note the second-order damage: because BOTH the 2011 probe and its
RECENT control were sent with the broken param, the archive-depth question is
still **UNMEASURED**, and the ranges doc's 2011 EMPTY says nothing at all.

All nine categories are now walked: AGM/EGM, Board Meeting, Company Update,
Corp. Action, Insider Trading / SAST, New Listing, Result, Integrated Filing,
Others. Spellings are EXACT and load-bearing — a near-miss reproduces the
original defect for ONE category, which is strictly harder to see than the
whole-job version was.

**2. Nothing was reported, so no monitor could fire.** `reportJobOutcome` sat
below THREE early returns (429 abort, fetch failure, `announcements.length === 0`).
Defect 1 made the third true every run, so the job emitted **no metric at all**.
`apply-monitors.sh` has carried `bse-announcements-sync|96h|weekdays 21:30`
since MONEY-1238, and `notify_no_data: true` means that monitor sat in NO DATA
from birth rather than alerting — the exact state that file's own comment warns
about. The report now lives in a `finally`; an idle run reports 0/0 and a
blocked one sets `transportFailures`. Note the monitor STILL cannot fire on a
zero-fetch run: `clamp(selected) - clamp(written)` is `0-0=0`, the "genuinely
idle" row of its own truth table. Which is why the job judges its own health.

**Zero across all nine categories is UNHEALTHY, not idle.** A whole-market feed
takes hundreds of filings a day; zero from all nine is a broken query, a blocked
egress or a renamed category. `judgeBseAnnouncementsHealth` says so at ERROR
level and puts the per-category census in `skippedReason`. A SINGLE empty
category is healthy but NAMED.

**THE DATE TRAP.** BSE rejects a `strToDate` it considers future with **HTTP
200** and `{"Table":[{"Column1":"Future Date cannot be selected"}]}`. That row
has no `SCRIP_CD`, so the parser drops it and the page reads EMPTY — the same
defect from a different direction. `detectBseApiError` recognises the envelope
and the window end steps back a day, bounded. A hard "always ask for yesterday"
clamp was REJECTED: it would make a 21:30 run structurally incapable of
ingesting a filing on the day it was filed, trading a self-announcing error for
a permanent blind spot.

**Results become `quarterly_result`.** Category in {Result, Integrated Filing}
AND a derivable period end. `period` is `"Jun 2026"` — month-name-of-quarter-end,
inside `parseDocumentPeriod`'s measured vocabulary, verified by round-tripping
through the real parser. NOT `Q1-2026`: `periodLabel` mints the FY-END year, so
a quarter label sorts by a year that does not mean what it appears to.

**periodEnd is real or absent, never fabricated.** Explicit `DD/MM/YYYY`,
`DD.MM.YYYY`, `DD-MM-YYYY`, plus a cue-gated quarter-end month name. Only
MONTH-END dates survive — that is what separates a period end from a submission
date ("submitted on 14/08/2026 for quarter ended 30/06/2026" keeps the second),
and it is what makes the day-first convention safe. `QUARTER_ID` is a
cross-check and never a source; a decodable contradiction ABANDONS the
derivation. A row with no period stays `corporate_filing` and loses nothing.

**Latest wins.** The quarter key means one row per company-quarter, so a
revision COLLIDES by design. Upsert, with the superseded `ATTACHMENTNAME` kept
in the description breadcrumb (`bse-meta xml=…;attach=…;newsid=…;cat=…;sub=…`),
which also carries BSE's `XML_NAME` — the breadcrumb for BSE XBRL discovery,
parsed off the wire and dropped on the floor before this. A superseding write
resets `isEmbedded`/`textContent`/`parseStatus`. **A row whose attachment never
archived is NOT skipped**: `gcsPath: ""` makes the parse lane terminal-FAIL it
on the first `downloadFromGCS("")`, so skipping on the attachment name alone
would strand a company-quarter permanently after one transient blip.

`scripts/data/backfill-bse-results.ts` reaches the BSE-ONLY cohort the daily
window never will. Run `--probe` FIRST — the archive depth is UNKNOWN, and it is
unknown because the probe meant to measure it went out with the same broken
`strCat=-1` this section fixes.

#### MONEY-1255 (A2) — the 2,389 companies no NSE-keyed producer could reach

The rotation fix made the BSE-only skip visible; it ceilinged coverage at 56.8%
of 5,523 real companies. **2,389 real companies are listed on BSE with no NSE
row**, and the note this file used to carry — "no producer in this repo can give
a BSE-only company an `annual_report`" — was right about our NSE legs and wrong
about screener.in, which carries 8-13 years of annual reports for 11 of 12
sampled BSE-only companies (hosted on `bseindia.com/bseplus/AnnualReport/<scrip>/`).

The obstacle was never that the documents do not exist. screener keys its
company page by a **slug**, and this job only ever had a ticker.

##### The slug is the BSE scrip code, and BSE already tells us what it is

`fetchBseScripMaster()` runs nightly on `instrument-sync-daily` and returns
scrip code + ISIN + name for the whole ~12,600-row active universe, through
`getFeedAsset` — archived on prod, replayed on QA. All 2,389 BSE-only companies
carry an ISIN. So:

    InstrumentMapping.isin  ->  BSE scrip master  ->  /company/<scripcode>/

Verified against `/company/530127/`, `/company/511122/`, `/company/512517/`,
`/company/526081/` — all 200, 8-13 annual-report links each.

- **ZERO extra requests to screener.** The company page fetch is the one we were
  already making. The host has 429'd us before (MONEY-853); the alternative
  design would have spent ~2,389 search calls to learn what BSE publishes.
- **ONE master fetch per run**, lazily, in a PER-INVOCATION closure. Never at
  module scope: Cloud Run keeps containers warm, and module-scope run state is
  the exact bug MONEY-1238 fixed in this same file.
- **ISIN first, scrip_id second.** The ISIN is the stable identity; BSE's
  `scrip_id` does not always equal our stored `symbol`, because a rename
  (MONEY-1177) leaves the two exchanges carrying different tickers for one
  company.
- **`bseScripCode` comes free and AUTHORITATIVE**, from the exchange that issues
  both identifiers — the join key the BSE XBRL bridge needs.
- A **non-numeric scrip code is refused** rather than encoded: it goes in a URL.

##### WHY `screener-resolve.ts` HAS NO HTTP CLIENT AT ALL

This is the part most likely to be "improved" later. Read it before adding a
search fallback.

Company identity comes from an **authoritative join**, not a judgement. There is
no name-similarity score on the live path, therefore **no threshold to mis-tune
and no near-match to accept by mistake**. The wrong-company failure — another
issuer's annual reports filed under our symbol, where nothing downstream can
tell (the PDF parses, the numbers project into `stock_financials` under our key,
every dashboard reads green) — is IMPOSSIBLE BY CONSTRUCTION rather than merely
guarded against.

The measure of that: an earlier draft resolved by searching screener and
defended itself with a Jaccard-plus-ordered-prefix rule. Mutation testing killed
"accept the first result", "auto-accept any numeric slug", "drop the prefix
test" and "drop the uniqueness check" — four real mutations, four real catches.
Against the scrip-master join **those mutations are unkillable, because the code
they mutate is no longer on the path a slug is produced by.** A guard you no
longer need beats a guard that works.

The module is pure and asserted to be: no `ky` import, no `fetch(`, no injected
http seam. A search fallback would reintroduce every one of those risks AND
break robots.txt. If a company has no scrip code, the honest answer is `miss`.

##### FOUR outcomes, and the fourth is not redundant

    resolved     an exchange-published ISIN -> scrip-code fact
    miss         we looked, BSE has no row  -> a FINDING, cached 90d
    ambiguous    one ISIN, two scrip codes  -> EXCLUDED, cached 90d
    unavailable  we could NOT look          -> cached NEVER

**`unavailable` must not be deleted as redundant with `miss`.**
`fetchBseScripMaster` returns `[]` on a failed fetch **and** under
`BSE_MASTER_ENRICH=off`. Reading an empty master as "no match" would stamp a
90-day "no page" finding onto EVERY BSE-only company on the page during a
transient BSE outage — caching a failure as a fact, which this codebase has a
standing rule against. Nothing is counted, nothing is persisted, and the symbol
is still STAMPED, so an outage costs a cycle rather than a stall. It prints as
`BSE SCRIP MASTER UNAVAILABLE — nothing cached`, because the alternative
signature (`served 0 / resolved 0 / miss 0 / ambiguous 0`) is something an
operator would have to INFER.

**Conflicts are EXCLUDED, never last-wins.** One ISIN against two scrip codes
would otherwise resolve by iteration order — a wrong company arrived at by
`Map.set` ordering, and the LAST remaining way this join could return one.

##### The rest of the shape

- **A third partition class, `bseOnly`.** `resolveLegsForTarget` turns the two
  NSE legs off (they read NSE endpoints) and the "Tickertape" leg too (a read of
  `stock_financials`, filled by an NSE-FILERS-ONLY XBRL ingest). It can only ever
  REMOVE legs. `bseOnly` is a SUBSET of `eligible` in PAGE ORDER, never an
  appended list: a class that always sorts last is always the one a wall-clock
  truncation drops, and an unvisited row keeps its stale marker and leads the
  next page — a livelock, not just unfairness.
- **`documentsSyncedAt` is stamped on EVERY outcome**, slug miss and outage
  included, or the symbol re-occupies the head forever.
- **The 90-day TTL applies to NEGATIVES only.** BSE does not reissue scrip codes.
- **Neither new column is ever in a Prisma `where`** — both `{f: null}` and
  `{f: {not: null}}` match ZERO rows on Mongo (MONEY-1050 / 1205 / 1234 / 1236).
- **`annual_report` was missing from `SCREENER_PAGE_DOC_TYPES`**, the leg gate,
  though `VALID_SCREENER_DOC_TYPES` has carried it since MONEY-853. A targeted
  `docTypes:["annual_report"]` request therefore never fetched the Screener page
  — the richest source of annual reports we have. Nothing errored; the request
  just returned less than it could.

##### robots.txt — why the search endpoint is absent, not merely unused

screener.in's robots.txt (fetched 2026-08-26) carries `Disallow: /*?q=`, which
covers `/api/company/search/?q=`, and `Disallow: /company/source/quarter/*`. The
company PAGE fetch is allowed and is all this feature adds.

The search was removed OUTRIGHT rather than kept as a guarded fallback: a code
path that CAN fetch a Disallowed URL is one flag flip from fetching it. A scan
enforces that no code in `packages/research/src`, `packages/core/src` or
`workers/src` builds that endpoint, with a companion case proving the scan fires
on the shape it forbids — so `screener-full-scraper.ts`'s long-standing claim
that "we never hit the Disallowed `?q=` search" is TRUE again and is now checked
rather than asserted.

That scan found ONE pre-existing violation: `searchScreener()` in
`screener-client.ts`, exported from the data-sources barrel with ZERO callers —
a dead export breaking the rule without buying anything. It has been DELETED
(function, barrel export, type). The exemption table that recorded it is now
EMPTY, and stays, so the first NEW entry is policed on the day it is added.

`buildQuarterSourceUrl` records the per-quarter raw-PDF endpoint shape and is
DOCUMENTED AND NOT FETCHED, for two independent reasons: `bse-announcements-sync`
is the primary source for quarterly, and two writers on one
`@@unique([symbol, exchange, docType, period])` overwrite each other on a
schedule nobody watches — and the path is named in that Disallow line.

The name-similarity helpers are retained, exported and tested because they
encode a real trap — `Bosch India` and `Bosch Rexroth India` score IDENTICALLY
(0.667) to a legitimate name variant, which is why an overlap threshold alone is
not safe — and an alpha-slug source would need them. A test asserts they have NO
caller in `src/`, so "not on the live path" is a CHECKED property.

##### The one hop that broke, and is now fixed

A `StockDocument(exchange:"BSE")` row survives every worker hop — extract, parse,
projection and embed carry no `exchange` predicate, parse stamps `doc.exchange`
onto `DocumentFinancialExtract`, and the projection carries it into the
`StockFinancials` unique key — and the Documents/Filings tab reads on `symbol`
ALONE, so the annual reports surface.

The NUMERIC surfaces did not. `apps/web/app/stock/[symbol]/page.tsx` defaulted
`exchange` to `"NSE"` AT THE DESTRUCTURE, which collapsed "the caller asked for
NSE" into "the caller said nothing"; the instrument lookup then missed and the
page synthesised an NSE row. Since every downstream numeric read is
exchange-scoped, a BSE-only company rendered an EMPTY Financials tab beside a
POPULATED Documents tab — the annual reports visible, the numbers extracted from
those same documents not.

Fixed in the same ticket: the raw param is read so its ABSENCE stays observable,
and a miss with no caller-named exchange retries on any exchange, NSE-ordered.
An explicit `?exchange=NSE` is still honoured exactly — including when it
returns nothing, because "NSE has no such listing" is a true answer.
`generateMetadata` carried the same default and is the one search engines index;
it now names an exchange only when the caller did, because an omitted exchange
is accurate for every company and a guessed one is wrong for 2,389.

STILL OPEN: a BSE-only company has no incumbent `StockFinancials` row, so its
financials are a CREATE — gated behind `createMissing` (default false). Arming
BSE financials means arming that too.

### Report Archive Sync Data (system-level, no userId) — MONEY-1097 (P2)

```typescript
{
  date?: string;        // YYYY-MM-DD trading day (default: most recent)
  cadence?: "daily" | "weekly" | "monthly" | "all" | "none";
  driftGuard?: boolean; // poll NSE's daily-reports index for NEW fileKeys
  familyIds?: string[]; // re-fetch specific families, bypassing today's skip set
}
```

Walks `REPORT_REGISTRY` (`@usemoney/core/market-data/report-registry`) and pushes
every **enabled** family's bytes through `getFeedAsset` into the GCS feed archive
at `feeds/{exchange}/{feed}/{YYYY}/{MM}/`. It **parses nothing** — deliberately.
NSE prunes its archives — MONEY-1096 proved it with real 404s on the PR zips for
1995/2000/2010 — so capturing files is urgent and parsing them is P4's job
(MONEY-1100). (A claim that BSE's pre-UDiFF `EQ_ISINCODE` zips were "gone" has
been retracted: those probes returned 200 + an HTML page, not 404, which says
the path did not resolve to a file and nothing about whether the file exists.)

**36 of 64 families ship enabled**, each one confirmed live by `--registry`. The rest are inventory rows: a guessed URL
404s _identically_ to a market holiday, so an unverified path could never
announce itself as wrong. Only rows whose `provenance` is evidence
(`p1-verified` / `p2-probed` / `api-captured` / `existing-code`) are fetched;
confirm the rest with `scripts/data/probe-exchange-archives.ts --registry` and
flip `enabled` from that output.

**Two nightly runs on purpose** (`report-archive-sync-evening` 19:30 IST,
`report-archive-sync-night` 21:45 IST, both Mon–Fri). The second skips families
the first already archived but deliberately RETRIES the absent ones — a 404 at
19:30 usually means "not published yet", which is the whole reason it exists.
The skip set is derived from prior runs' `MarketDataSyncLog.metadata`, **not**
from a GCS presence check. The reason this doc used to give — "`FEED_ARCHIVE_MODE`
is unset, so `exists()` would return false for every family" — expired on
2026-08-12, when prod was armed with `archive`. Three that did not: (1) **there
is no `exists()` to call.** `FeedArchiveStore`
(`packages/core/src/market-data/feed-archive.ts:127-133`) exposes exactly
`get(key): Buffer | null` and `put(...)`, so the cheapest presence probe
available today DOWNLOADS every family's bytes — the whole night's payload pulled
back out of GCS to decide what to skip — against one Mongo read for the entire
run. (2) **Only one of the three terminal outcomes leaves an object.** `TERMINAL`
is `{archived, fetched, skipped}` (`report-archive-sync-logic.ts:67-71`), and
both `fetched` (validated but deliberately NOT stored because the archive is
disarmed — `report-archive-sync.ts:437-439`) and `skipped` write nothing, so a
presence probe would re-fetch both. Prod no longer produces `fetched`, but every
env with `FEED_ARCHIVE_MODE` unset still does: local dev, and the documented
default for any new env. (3) **The bucket stopped being per-environment
evidence.** Prod's `feeds/` prefix is now mirrored wholesale into QA's bucket,
while `market_data_sync_logs` is explicitly EXCLUDED from the prod→QA Mongo copy
as "environment-specific" (`scripts/ops/sync-prod-to-qa.sh:249-251`) — so object
presence answers "did _somebody_ archive this?" where the sync log still answers
"did THIS env's run capture it?", which is the question the retry is keyed on.
That third one is latent rather than live (all four jobs are prod-only), but it
is why presence can never be promoted to the authority here. One layer down it is
the MONEY-1100 lesson restated: keys are deterministic and a re-run overwrites in
place (`feed-archive.ts:381-383`) on a service running `containerConcurrency: 10`
with no mutex, so an object at a key proves SOME write landed, never that this
run's bytes did.

`report-archive-monthly` (3rd of month, 08:00 IST) covers the four
Capital-Market > Mutual Fund monthly files. Their URLs carry NO date param, so
they always serve the current month and are archived under the fetch month —
without that the series would overwrite itself every cycle.
`report-archive-drift-weekly` (Sat 20:00 IST) runs with `cadence:"none"` — it
archives nothing and only polls NSE's `daily-reports?key=…` index, warning about
fileKeys that appeared **since the last observation**. Diffing against the
registry instead would warn about ~150 keys every week, and an alert that always
fires is not a signal. The first run stores a baseline and warns about nothing.

All four are in the scheduler's `PROD_ONLY_JOBS` (scrape-once); QA reads the
mirrored `feeds/` prefix instead of scraping the exchanges a second time.

Pure decisions live in `report-archive-sync-logic.ts` (unit-tested); the I/O
orchestration is in `report-archive-sync.ts`. The route returns **500** on a
throw so Pub/Sub retries — unlike the ACK-200 routes (investor-rollup,
stock-document-extract), because a failed archive run is worth retrying: the
files are still being pruned upstream.

Outcomes distinguish `archived` (bytes reached GCS) from `fetched` (validated
but NOT stored because the archive is DISARMED) from `store-failed` (archive
ARMED, GCS write did not land — MONEY-1100). `archived` and `fetched` are
terminal for the day; `store-failed`/`absent`/`rejected`/`failed` are retried
by the 21:45 run. Conflating stored-vs-not was a lie the sync log used to tell
(`getFeedAsset` returns a Response either way), and conflating
disarmed-vs-write-failed cost a night of files when the archive first went
live — a failed store is bytes we do NOT have, exactly what the second run
exists to re-fetch.

### Institutional Flow Sync Data (system-level, no userId) — MONEY-1108 (P8d)

```typescript
{
} // no parameters — the endpoint takes none either
```

Daily FII/DII provisional cash-market flows from NSE `/api/fiidiiTradeReact` →
`InstitutionalFlow {date, category FII|DII, segment, buyValue, sellValue,
netValue}` (₹ crore, stored unconverted). Feeds the sentiment panel; derivables
(flow streaks, flow-vs-Nifty overlay, monthly aggregates) read the table.

**UNBACKFILLABLE — the schedule is the risk, not the parser.** The endpoint
takes no date parameter and serves only the CURRENT reading, so a missed day
never enters the record. Same property as `surveillance-sync`; hence daily
(`institutional-flow-sync-daily`, 20:30 IST Mon–Fri) and a **500 on failure** so
Pub/Sub retries. Raw responses archive to `feeds/NSE/api/fii-dii/` via the
`FAMILY_BY_PREFIX` row added by **MONEY-1195**, which is a hard prerequisite:
without it `archiveNseJsonResponse` files nothing while reporting success.

**PROD_ONLY** (scrapes nseindia.com). QA receives `institutional_flows` through
`sync-prod-to-qa.sh` — it is market-wide with no `instrumentId` FK, so unlike
`daily_prices` it mirrors cleanly without disturbing QA's own ObjectIds.

Idempotent by upsert on the `(date, category, segment)` unique — the OPPOSITE
call from `StockFlag`, which forbids a unique because consecutive days are its
datum. Here each key is one scalar reading, so a redelivery must overwrite
rather than double the day's flows. Pure parsing is in
`@usemoney/core/market-data/institutional-flows` (unit-tested); the processor
does I/O only, and never writes on a null fetch or a zero-row parse — an empty
FII/DII list is a meaningful claim about the market that a failed fetch must not
be allowed to make.

**The NSDL FPI leg is NOT implemented** — see the written TODO at the top of
`processors/institutional-flow-sync.ts`. No NSDL endpoint exists anywhere in
this repo, its transport (file feed vs JSON API) is unknown, and its
fortnightly sector-wise shape does not map onto this table. A guessed URL would
404 identically to a non-publication day and return zero rows forever while
every log line read as success.

### Macro Sync Data (system-level, no userId) — MONEY-1106 (Data Engine P8b)

```typescript
{
  sourceIds?: string[];   // restrict to these MacroSource ids; omitted = all
}
```

Official Indian macro series — CPI, WPI, repo, CRR/SLR, forex reserves, call
money — from **RBI's National Summary Data Page**
(`www.rbi.org.in/Scripts/BS_NSDPDisplay.aspx?param=N`). Three pages, all
live-verified from our own egress on **2026-08-13**:

| Source id         | Page       | Cadence | Carries                                                                                                    |
| ----------------- | ---------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `rbi-nsdp-rates`  | `param=4`  | weekly  | CRR, SLR, repo, reverse repo, SDF, MSF, bank rate, savings rate, call money, T-bill + 10Y yields, INR spot |
| `rbi-nsdp-forex`  | `param=2`  | weekly  | Total reserves, FCA, gold, SDRs, IMF position — each in ₹ crore AND US$ million                            |
| `rbi-nsdp-prices` | `param=15` | monthly | MOSPI CPI combined/rural/urban, CPI-IW, OEA WPI + primary articles / fuel & power / manufactured           |

`param=15` is why one host covers three publishers: it is RBI republishing
MOSPI's CPI and the OEA's WPI, and its own footer says so. **DBIE was rejected**
— `data.rbi.org.in` is an Angular SPA over a TCS "CIMS" gateway with a session
handshake and ~90 undocumented RPC endpoints, against the ticket's "keep the
scraper thin".

The registry, both HTML parsers, the label map and the freshness judgement are
pure and unit-tested in `@usemoney/core/market-data/macro-series`
(`macro-series.test.ts`); the processor only does I/O.

**Idempotency.** `MacroSeries` is `@@unique([seriesId, period])` and the worker
upserts. Re-ingestion is the NORMAL case, not an error: the rates page shows 6
week-ended columns and the prices page 3 months, so every run re-reads periods
it already stored — that overlap is exactly what heals a missed run. `source`
and `unit` are deliberately NOT in the key (provenance and magnitude, not
identity; the two forex magnitudes are already separate `seriesId`s).

**Three outcomes are kept distinct**, which is the point of the ticket:
a fetch failure writes NOTHING (it must never assert "no observations this
week"); a parsed table matching zero tracked series returns `rows: []`; a page
with no recognisable table returns `null`. The first three set `ok=false` → 500
→ Pub/Sub retries. A **STALE** source does not — retrying cannot un-freeze a
discontinued page, and probing `param=1..30` found **nine NSDP tables still
serving 2003–2014 data under a permanent HTTP 200**, which is precisely why
`judgeMacroFreshness` exists.

**Not shipped, with written TODOs in `macro-series.ts`:** IIP (MOSPI's
`api.mospi.gov.in/api/esankhyiki/records` endpoint is live but the `SECTION` id
for IIP is unknown — a wrong id returns 200 + an HTML SPA shell), and the OEA
full WPI commodity tree (URL and sheet layout verified, but prior months are not
addressable — `wpi_monthly_index_202606.xlsx` returns 200 with a 1 KB error
page).

Prod-only (`macro-sync-weekly` Sat 08:00 IST after Friday's WSS;
`macro-sync-midweek` Tue 08:00 IST). The midweek run is a genuine second chance
rather than redundancy: the forex page publishes a SINGLE "as on" column and
cannot self-heal the way the rolling pages do. QA is fed twice over — it replays
the archived HTML from `feeds/RBI/` and also receives `macro_series` through
`sync-prod-to-qa.sh`'s `REFERENCE_COLLECTIONS`.

### XBRL Sync Data (system-level, no userId) — MONEY-1113 (Data Engine P10 F1)

```typescript
{
  windowDays?: number;   // trailing window, default 7, clamped 1..370
}
```

Company financials read from the FILING rather than from somebody's reading of
it. Walks NSE's results index over a trailing window, downloads each filing's
XBRL XML from `nsearchives.nseindia.com` (cookieless, but a browser UA is
required) and upserts `XbrlFiling`.

**THERE ARE TWO INDEXES, and building against the documented one is a silent
no-op.** SEBI's integrated-filing regime took effect for the quarter ending
Dec-2024, and `/api/corporates-financial-results` stopped receiving new filings
exactly there — 2,402 records for Nov-2024, **31** for Nov-2025.
`/api/integrated-filing-results` took over. Both are needed: the modern one for
anything current, the legacy one for the P10 F2 backfill.

**The modern index caps at 20 records by default.** Measured: a 46-day window
and a 6-day window returned the same 20; the same window with `&size=5000`
returned 5,000 across 2,101 symbols. It is not literally silent — the envelope
carries `{size, page, totalCount}` — but the LEGACY index returns a bare array,
so unwrapping written for both reaches past `data` and drops the rest.
`detectTruncation` reads `totalCount` first and keeps a structural fallback
(newest-N caps make every record cluster on the window's LAST day) for the
legacy index, which genuinely has no envelope.

**THE STUB URL.** A filing with no XBRL still carries a well-formed url ending
in a bare dash. It starts with "http", so `startsWith('http')` reports ~100%
coverage back to 2012. On the `.xml` suffix: 0% through Feb-2018, 89% May-2018,
97-98% from 2019.

**The four index flags are NOT Y/N** — `consolidated` is
"Consolidated"/"Non-Consolidated", `audited` is "Audited"/"Un-Audited",
`cumulative` is "Cumulative"/"Non-cumulative", and `bank` has THREE values
(`N`/`B` bank/`F` other financial). An `=== "Y"` test makes all of them false.

**THE TWO ERAS ALSO SERVE TWO TAXONOMIES (MONEY-1200)** — the seam one layer
below the two indexes, and the parser was built against the wrong one. Legacy
filings declare `xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin/{date}/in-bse-fin"`;
every current filing declares
`xmlns:in-capmkt="http://www.sebi.gov.in/xbrl/{date}/in-capmkt"`. Result,
measured on prod 2026-08-14: `downloaded: 1500, unparseable: 1499, written: 0,
ok: true` — and `xbrl_filings` EMPTY, while the legacy parser test suite stayed
green because all three of its fixtures predate the regime change.

Dispatch is now on the DECLARED namespace. The `in-capmkt-ent` namespace names
the ENTRY POINT, and that is the only reliable family signal: the integrated
`<link:schemaRef>` href is `in-capmkt-ent-{date}.xsd` for EVERY entry point (so
the legacy "href mentions banking" rule is dead), and an NBFC files
`InterestEarned` **beside** `RevenueFromOperations` (so the legacy tag rule
classifies every NBFC as a bank — NAGA DHUNSERI reports ₹3.93 lakh of interest
against ₹94.48 Cr of revenue). Four families now: `ind-as`, `banking`, `nbfc`,
`non-ind-as`. A namespace or entry point we cannot read is a **counted
outcome**, never a zero — an insurance entry point read through the Ind-AS map
would file plausible numbers under the wrong concepts.

**GOVERNANCE filings carry no financials by design** (29 of 500 in a live
window) and are counted as `nonFinancial`, not `unparseable`. Conflating them
puts a permanent ~6% floor under the failure ratio, which forces the threshold
up past the noise and blunts the signal.

**`ok` is no longer initialised true and forgotten.** It was cleared only when
the INDEX was unreadable, so 1,500 documents could fail without touching it —
the MONEY-1189 wrong-granularity class. `judgeXbrlParseHealth`
(`xbrl-sync-logic.ts`, pure + unit-tested) fails a run when
`(unparseable + unknownTaxonomy + noPeriod) / (downloaded - fetchFailed)`
exceeds **10%** over a ≥20-document sample, and at ANY sample size when it is
100%. Transport failures stay out of the numerator (NSE indexes filings before
the archive serves them).

**The response code is chosen by failure CLASS, not by `!ok`.** A transient
index failure still returns 500 — it costs one HTTP call. A deterministic parse
failure returns **200**: it fails identically every attempt, and each attempt
re-downloads up to 1,500 XMLs from NSE (a deterministic failure writes nothing,
so the `skippedExisting` short-circuit never engages). The trailing window, not
the retry, is what heals it once the concept table is taught.

**RESOLVED — the run is bounded by WALL CLOCK now (MONEY-1201, PR #323).** This
paragraph used to read STILL OPEN, and the shape of the fix is worth keeping
because the lever it proposed was the wrong one.

The problem: `MAX_DOWNLOADS_PER_RUN` (1500) × `DOWNLOAD_DELAY_MS` (600 ms) is
900 s of SLEEPING alone — before one HTTP round trip or indexed read — against a
Pub/Sub `--ack-deadline=600`, which is Pub/Sub's MAXIMUM and cannot be raised. A
full run was arithmetically incapable of finishing inside its own deadline, so
Pub/Sub redelivered while the first attempt was still running and each
redelivery began another complete pass. That fits the ~11 deliveries in 57
minutes measured on 2026-08-14 far better than a NACK chain does, since
`--max-delivery-attempts=5` caps that at five.

The proposed lever — "a smaller per-run budget (~800)" — was NOT taken, because
halving a COUNT moves the cliff instead of removing it. Per-document cost is a
fixed delay plus a network round trip plus an indexed read, and only the first of
those three is ours; a count holds only while the other two stay put.

What shipped instead is `RUN_TIME_BUDGET_MS = 480_000` in
`processors/xbrl-sync.ts`: the download loop breaks when elapsed wall clock
passes the budget, sets `truncatedByBudget`, and leaves the remainder to the
TRAILING WINDOW — which is what the window is for, and why this job is
backfillable in the first place. 480 s of 600 s leaves 120 s of headroom for the
index paging before the loop and the writes after it. Deliberately not 590:
being wrong here does not make a run slow, it DUPLICATES the run.
`MAX_DOWNLOADS_PER_RUN` (1500) survives as a runaway guard only — the constraint
that actually binds is time, and a count cannot express it.

Backfillable, so the schedule is not load-bearing and the trailing window heals
a lost run. Existing filings are skipped BEFORE the download, which is what
makes the overlap nearly free. Prod-only (per-filing fan-out); QA gets
`xbrl_filings` via `sync-prod-to-qa.sh`.

### Circulars Sync Data (system-level, no userId) — MONEY-1187 (P11 item 7)

```typescript
{
  windowDays?: number;   // trailing window, default 14
}
```

NSE exchange circulars from `/api/circulars`, whose response is **WRAPPED**
(`{data, fromDate, toDate}`) — a bare-array assumption yields zero circulars
from a perfectly good 200 and reads as a quiet week.

**`circNumber` is NOT unique.** Over one live 237-record window only 205 numbers
are distinct: NSE re-issues a circular under EVERY department it applies to.
Keying on the number alone silently discards half of every re-issued circular,
and the surviving row looks completely normal. `(circularNumber, department)` is
237/237 unique and is the key.

The topic classifier reads subject and department BEFORE category, because all
45 surveillance circulars carry `circCategory: "Compliance"` — category-first
leaves SURVEILLANCE permanently empty while the taxonomy looks healthy. `OTHER`
is an unconditional catch-all absorbing ~1.7% of live traffic.

### MF Portfolio Sync Data (system-level, no userId) — MONEY-1105 (P8a)

```typescript
{
  month?: string;      // "YYYY-MM"; default = LAST month (M's data ships in M+1)
  only?: AmcId[];      // subset of the AmcIds below — the CONTINUATION CURSOR
  chainDepth?: number; // MONEY-1490 self-chain depth; 0 on a scheduler trigger
}
```

**EVERY ONE OF THESE WAS SILENTLY DROPPED UNTIL MONEY-1490.** The route read
them off the Pub/Sub push ENVELOPE (`{message:{data:"<base64>"}}`) instead of
the decoded payload, so `month` and `only` were `undefined` on every scheduled
and every chained run. In an ordinary job that degrades to "ran with defaults";
here `only` IS the continuation cursor, so the self-chain never terminated —
each hop discarded the remainder, re-ran the full house table from the top, and
re-published the same tail. Measured on prod 2026-09-21: seven days, ~240 runs
a day, the same first four or five houses re-fetched and re-upserted (22,157 /
27,592 rows a hop) while the fourteen houses from ABSL to HDFC were never
fetched once. `workers/__tests__/route-pubsub-envelope-unwrap.test.ts` scans
every route for the shape.

SEBI-mandated monthly holdings → `MfPortfolioHolding`. **17 of AMFI's 57
registered AMCs are resolved** (MONEY-1405), by TWO mechanisms:

- **template** (SBI, Nippon, Kotak, ICICI Prudential) — a URL built from the
  month. ICICI's month FOLDER alternates spellings with no rule (`Apr`, `May`,
  `June`, `July`, `Aug`) while its filename is always the full month, so that
  entry carries `altUrls` and the FETCH settles which is right rather than a
  guess.
- **page-scrape** (DSP, PPFAS, Tata, Zerodha, Groww, Old Bridge, Capitalmind,
  Mirae, Baroda BNP, Shriram, Helios, 360 ONE, ABSL) — TWO fetches, the landing
  page then the file a resolver picks out of it, because these houses' paths
  carry random hashes or epochs and are not templatable at all. Every one was
  proven by fetching the exact URL the resolver itself selects, not a
  hand-typed one — and, since MONEY-1405, by PARSING what came back: a row
  count proves a house fetched, never that it parsed.

**DO NOT read the count off this line.** `resolverCoverage` joins AMFI's own
registry on `amfiMfId` and `mf-portfolio-sync` logs it nightly with the
remainder NAMED; `scripts/data/amc-disclosure-registry.ts` prints the same diff
with each URL's live HTTP status. This paragraph has been stale twice.

`pickLinkForMonth` returns null for ZERO matches AND for MORE THAN ONE —
several houses publish the same month twice under different spellings (Zerodha
ships `Sep` and `Sept`), and nothing in the filenames says which is
authoritative, so ambiguity is reported rather than guessed.

**HDFC is verified and fetched PER SCHEME**: it publishes one workbook per
scheme, so a month alone cannot address it — the scheme LIST comes from the
NAVAll index.

**ABSL and Kotak are resolved as of MONEY-1405**, and both cost a discovery
apiece: ABSL's filename is genuinely ad-hoc (seven conventions in eight
months), so it is a page-scrape rather than a template, its Sitecore listing
needs `&year=0` (with `&year=` it answers **500** wearing a 404 page), and
every URL it publishes is on `abcscprod.azureedge.net`, a RETIRED Azure CDN
with no DNS record — so the fetch fails to RESOLVE rather than 404, and the
entry carries `rebaseHosts` to re-point it at the origin. Kotak is one
consolidated workbook, not per-scheme, and must never be fetched from the
`www.` host (Radware).

**UTI is resolved and still BLOCKED**, on a parser feature rather than a URL.
Its zip DOES hold the consolidated holdings (8,228 rows, real ISINs and
weights) — MONEY-1197's "4 ancillary disclosures" note is half wrong — but as
ONE sheet holding every scheme end to end, delimited by
`SCHEME CODE<nnn>STARTS` / `SCHEME: <name>` rows, and dated `AS OF` rather than
`as on`. Our parser is one-sheet-per-scheme, so ingesting it as-is would merge
~100 UTI schemes into a single portfolio. 1,303 funds; its own ticket.

A house that is REPORTED as skipped-by-provenance is reported rather than
dropped, because a guessed URL 404s identically to "not published yet".

**Nippon keeps only the CURRENT month** (June 404s while July serves), so for
that AMC the schedule carries the risk — hence runs on the 12th AND the 20th.

Traps the parser handles: Nippon's `.xls` is OOXML while ABSL's INNER `.xls` is
genuine OLE2 (the extension lies in both directions, only magic bytes decide);
the percent column is stored at TWO SCALES (fraction vs percent — a silent
100x, resolved from the number format); sheets hold MULTIPLE tables (one ABSL
sheet summed to 1.45 billion before the boundary fix); and `XLSX.read` HANGS
FOREVER, never throwing, on a truncated zip.

MONEY-1405 added five more, and every one of them produced a workbook that
parsed "successfully" and was WRONG rather than an error anyone could see. The
full account is in the root `CLAUDE.md` under **Indian mutual funds**; in
short: an over-anchored header regex drops a whole house silently (Tata's
`ISIN CODE`, 360 ONE's `Rounded % to Net Assets` — both wrote ZERO rows for the
life of their source while reporting `FETCH_FAILED`); a period may be stated
with no day and a different preposition (Zerodha's `… FOR AUGUST 2026`); a zip
member may DEFER its own size so local headers read `compressedSize: 0` and the
central directory is the only reliable reader (ICICI, 147 members); a MERGED
header cell empties its column (Kotak — 119 sheets, 110 holdings, every ISIN
null); and a subtotal may sit on a SECTION HEADING rather than a `Total` row
(ICICI, ~300% per sheet).

The consequence for reading this job's output: **a per-AMC row count is not
evidence that an AMC parses.** Prod reported 26,521 rows written on the same
run that dropped Tata and 360 ONE entirely.

**Scheme identity is resolved via AMFI's NAVAll feed**, which we already ingest
and which is grouped BY AMC — narrowing the match from 14,273 industry-wide
schemes to a median of 130. Measured **326/333 (97.9%)** on the real committed
workbooks. Only an UNAMBIGUOUS match sets `amfiSchemeCode`; an ambiguous name
leaves it null, because a wrong code silently attributes one fund's holdings to
another and a null is at least visibly absent. `schemeKey` (our normalisation
of the printed name) remains the storage key, so a NAVAll outage degrades the
enrichment rather than blocking the ingest.

### US EOD Sync Data (system-level, no userId) — MONEY-980 (tasks 6 + 7)

```typescript
{
  symbols?: string[];      // Tiingo spelling (BRK-A, SPG-P-J). Scoped runs NEVER chain.
  batchSize?: number;      // EOD page size (default 800, clamped 1..5000)
  mfBatchSize?: number;    // NAV page size (default 200, same clamp)
  lookbackDays?: number;   // trailing window per symbol (default 5, clamped 1..30)
  skipFx?: boolean;        // skip leg (d); strict `=== true`
  chainDepth?: number;     // self-chain depth; 0 on a scheduler trigger
  chainStartedAt?: number; // epoch ms of link 1 — the rotation-wrap reference
}
```

The scheduler payload is `{}`. Every field is an OVERRIDE for a manual run;
the defaults are constants in `us-eod-sync-logic.ts`, because a number pinned
in `setup-scheduler.sh` and a constant in the worker are two spellings of one
fact and that file has no way to fail when they drift (MONEY-1255). Every field
is read and NARROWED in `routes/us-eod-sync.ts` — a field declared on the type
and forwarded by nobody is silently inert, which is exactly what happened to
`createMissing` (MONEY-1235).

**FOUR COUNTED LEGS, one job.** They share one upstream, one token and one
rate-limit budget that Tiingo reports NOTHING about — there is no
remaining-quota header (verified: a successful EOD call returns only
`x-frame-options`), so a 429 is the only feedback channel and four separate
jobs would race for a ceiling none of them can see.

| Leg | What                                        | Writes                         |
| --- | ------------------------------------------- | ------------------------------ |
| (a) | EOD bars for ACTIVE US equities/ETFs        | `Candle`                       |
| (b) | US mutual-fund NAVs (the NAV rides in OHLC) | `Candle`                       |
| (c) | corporate-actions delta, **derived**        | adjusted-series cache eviction |
| (d) | the session's USDINR rate                   | `FxRate`                       |

#### Leg (c) has no endpoint, and that is a MEASUREMENT

Tiingo's dedicated corporate-actions endpoints are **not entitled on our plan**.
All four forms were tested against our live token on 2026-08-28 and all four
answered 403: `/tiingo/corporate-actions/AAPL/splits`, `…/distributions`,
`…/splits?exDate=`, `…/distributions?exDate=`. Building leg (c) as a feed would
have produced a job that 403s every night while reporting a healthy quiet
market — the shape that hid Tickertape's block for five months.

It does not need one. `divCash` and `splitFactor` are COLUMNS ON THE EOD
RESPONSE legs (a) and (b) already download: `divCash > 0` IS a distribution on
that ex-date, `splitFactor != 1` IS a split. The delta therefore costs **zero
extra requests** and cannot drift from the prices, because it is the same
bytes. Its effect is a TARGETED eviction of the adjusted-series cache — the
whole reason the schema computes adjustment at READ time rather than storing
it, so a new action is a cache invalidation instead of a rewrite of up to
11,517 historical rows. A blanket flush would evict ~14,000 other symbols
nightly for the sake of a few dozen.

`caKeysCleared` is reported and is this leg's FALSIFIABILITY: actions detected
with zero keys cleared, night after night, means the pattern in
`adjustedSeriesCachePattern` and `CandleRepository`'s key namespace have
drifted apart — a stale adjusted series served across a split. Making the call
is not evidence the call did anything.

It deliberately does **not** write `CorporateAction` rows. That table is
India's, fed by Screener/NSE and read by the FIFO pairing cost-basis
adjustment; a US split landing in it under a bare ticker would adjust an Indian
holding's cost basis, silently and plausibly and wrongly.

#### 403 has TWO meanings and the status alone cannot separate them

Measured 2026-08-28: an ENTITLEMENT refusal is 403 with **zero bytes and no
content-type**; a BAD TOKEN is 403 with `{"detail":"Invalid token."}`. The
client classifies on the BODY (`classifyTiingoError`) and raises
`TiingoAuthError{isTokenProblem}`; this job branches on that flag, names the
right cause in `skippedReason`, and stops the run either way — both are
deterministic and a retry collects the identical 403. 429 behaviour is
UNDOCUMENTED and untested, so anything carrying a rate-limit phrase is treated
generously as a rate limit: mistaking quota exhaustion for a permanent auth
failure costs a silently dead nightly job.

#### The cron is `2-6`, not `1-5`

A US session on day D closes at 16:00 ET = **02:30 IST on D+1**, and every job
in `setup-scheduler.sh` runs `--time-zone=Asia/Kolkata`. So the IST weekdays
that FOLLOW a US trading day are Tue..Sat. A `1-5` cron would fire on Monday
(whose preceding US day is Sunday — no session at all) and never on Saturday,
so **Friday's US close would never be ingested**. Same class as the bhavcopy
weekend gap, one timezone further out.

That also sets the monitor window: a `2-6` cron gaps Sat 11:00 → Tue 11:00 =
**72h**, so `apply-monitors.sh` registers `us-eod-sync|96h|Tue-Sat 11:00`. A
36h window would sit in NO DATA every weekend, which is exactly what got
`bhavcopy-sync`'s monitor muted (MONEY-1238).

#### Why 11:00 IST and not 07:00

The run is gated by the LATER of two upstream boundaries, not the earlier one.
Equity corrections close **8:00 PM ET** (06:30 IST under EST), but fund NAVs
are not published until after **12:00 AM ET** (10:30 IST under EST). The job
originally sat at 07:00 IST, which cleared the correction window and missed the
NAV window by three and a half hours — leg (b) would have fetched an empty NAV
set every single night without failing, which is why the leg verdicts below
distinguish an empty result from an unasked one.

Moving it had a consequence worth stating, because it broke a FUNCTION rather
than a comment: at 11:00 IST New York has just passed **midnight**
(00:30 EST / 01:30 EDT), so `resolveUsSessionDate`'s original "today in New
York" named a session that had not opened, and leg (d) would have stamped
`FxRate.date` one day forward every night. The rule is now expressed against
the **16:00 ET close** rather than against the current hour, which returns the
same answer under both the old clock and the new one.

QA DOES NOT RUN THIS JOB. `us-eod-sync-daily` is in `PROD_ONLY_JOBS`, and
`candles` + `fx_rates` are in `REFERENCE_COLLECTIONS`, so QA receives exactly
what prod computed.

That is a deliberate departure from `bhavcopy-sync`, which runs in BOTH envs and
replays prod's archived bytes. The difference is the row, not the policy:
`DailyPrice` keys on `instrumentId` and QA holds its own instrument `_id`s, so
India's price rows are NOT portable and QA has to re-ingest. `Candle` keys on
(symbol, exchange, timeframe, ts) and carries no ObjectId reference, so a
`mongorestore` lands correctly in an environment with different instrument ids.

Given the choice, copying is safer here: Tiingo is a PAID METERED api and a
replay MISS is a soft failure by design, so any drift in mirror timing would
silently spend a second full copy of the quota (~73k requests) rather than
degrade. This removes that failure mode instead of scheduling around it.

The DAY field stays `2-6`: it encodes a fact about the exchange, not about the
environment.

#### Rotation, budget, chain

- **The marker is in `orderBy` ONLY.** `[{usEodSyncedAt:"asc"},{symbol:"asc"}]`,
  plain `asc` (never `{sort,nulls}` — that is a Postgres feature). The
  attribute is ABSENT, not null, on every pre-existing `instrument_mappings`
  row, so `{usEodSyncedAt: null}` matches ZERO and a `where` on it would make
  the job report a clean, healthy, entirely empty run forever (MONEY-1050 /
  1205 / 1234 / 1236). Mongo sorts a missing field lowest, so under `asc` the
  never-synced rows lead — exactly right. The `symbol` tiebreak matters because
  stamping is chunked: 100 rows share one timestamp, and an arbitrary order
  over a constant key is the MONEY-1211 shape.
- **Every VISITED row is stamped**, before its work and flushed from a
  `finally` — skips, 404s and failures included. Stamping only on a WRITE is
  how `annual-reports-sync` stalled: a symbol that legitimately has no bars
  keeps its stale marker and re-occupies the head forever.
- **A wall clock, not a bigger batch.** `RUN_TIME_BUDGET_MS = 420_000` against
  the 600s ack deadline, checked BETWEEN symbols. Leg (a) yields at
  `EQUITY_LEG_BUDGET_MS = 300_000` so leg (b) is never starved — a class that
  always sorts last is the one a truncation always drops, and a dropped row
  keeps its stale marker and LEADS the next page, which is a livelock rather
  than a delay (MONEY-1255 A2).
- **THREE walls, and only one of them is the 420s one.** `RUN_TIME_BUDGET_MS`
  is THROUGHPUT (no new symbol past it). `UPSTREAM_CALL_DEADLINE_MS` is the
  ACK-DEADLINE wall, checked before EVERY upstream call and derived as
  `600s - one worst 155s call - POST_CALL_TAIL_MS`.

  **The third wall is GONE from this job.** `NEWS_WRITE_DEADLINE_MS` bounded
  leg (f)'s ROW WRITES, and leg (f) was retired to `tiingo-news-poll`
  (MONEY-1309) because this job's cron is a MARKET schedule and news is not a
  market. Verified 2026-09-01: `NEWS_WRITE_DEADLINE_MS`, `NEWS_WRITE_CHUNK_ROWS`,
  `newsWriteTruncated` and `newsWriteSkipped` appear NOWHERE in source. Only
  `TIINGO_NEWS_MAX_LIMIT` survives, and it lives in the new poller
  (`tiingo-news-poll.ts`), not here — so do not read the paragraphs below as
  describing anything this job still does.

  **`POST_CALL_TAIL_MS` is a SUM OF NAMED TERMS, not a rounded-up guess.** It
  was a hand-picked 45s whose itemisation understated leg (d) by 30s:
  `getExchangeRate` makes TWO sequential `fetchQuotes` calls (the pair, then
  the reverse), each bounded by `QUOTE_FETCH_BUDGET_MS` (20s), and the
  processor passes no timeout of its own. The module `rateCache` does not
  rescue it — only VALID rates are cached, so a Yahoo outage pays the full
  ladder every run. The bound is now IMPORTED from `yahoo-api-logic` rather
  than restated, so it cannot drift. 15s (leg (e) write) + 41s (leg (d)) + 3s
  (un-gated queries) + 1s (report + chain publish) = **60s**, which moved the
  call deadline 400s -> 385s and `PRICE_LEG_BUDGET_MS` 380s -> 365s to keep
  legs (e)/(f) their `SECONDARY_LEG_SLICE_MS` (20s). At a 5s slice leg (f)
  would have been refused on roughly half of all nights.

  **Leg (f)'s WRITE loop had no clock check at all**, and it is the one term a
  duration could never have expressed: `rows` is `articles x tickers-carried`
  over up to two full 5,000-article pages, so 10-15k sequential upserts is an
  ordinary busy session — 100-150s at ~10ms each, arriving after every other
  budget is spent. It is now gated between chunks of `NEWS_WRITE_CHUNK_ROWS`
  on an ABSOLUTE deadline against the ack ceiling (`600s - 45s of tail - one
chunk`), because a duration would compose with everything before it and could
  still land past 600s. Stopping early is a COUNTED, NAMED partial outcome
  (`newsWriteTruncated` / `newsWriteSkipped` /
  `NEWS_WRITE_DEADLINE_REASON`), reported separately from `newsTruncated`:
  that one is Tiingo's offset ceiling (we could not FETCH the rest of the day),
  this one is our own clock (we fetched it and could not WRITE it), and only
  the second is ours to fix.

  **The guard for all of this used to prove nothing.** The test asserted
  `worstCaseRunMs(latestUpstreamCallStartMs(w), w, POST_CALL_TAIL_MS) <= 600s`
  — and `latestUpstreamCallStartMs` SUBTRACTS `POST_CALL_TAIL_MS`, so it holds
  for every value of the constant under test, including a wrong one. Every
  term is now re-derived from the module that DECLARES it, read off disk:
  `QUOTE_FETCH_BUDGET_MS` from `yahoo-api-logic.ts`, the fetcher-call count
  counted in `exchange-rates.ts`'s code, the retry ladder from
  `tiingo-client.ts` + `exchange-feed.ts`, the row ceiling from
  `TIINGO_NEWS_MAX_LIMIT`/`_OFFSET`.

- **A second stop condition sized from the PLAN.** `requestBudgetForRun` =
  `perHour x (budgetMs / 3_600_000)` — a run lasting 7/60 of an hour may spend
  7/60 of an hourly allowance, and the property composes across a chain because
  each link derives its own cap from its own duration. `tiingoLimits()` is
  called PER RUN, never snapshotted at import; `TIINGO_PLAN` defaults to
  COMMERCIAL, the LOWER pair, because guessing high walks into a 429 wall
  mid-page while guessing low only runs slower (MONEY-1262).
- **`lookbackDays` is CLAMPED to 30, and the clamp is a safety property.** One
  Tiingo request returns a symbol's ENTIRE history (AAPL: 11,517 bars / 820 KB
  in one 2.4s call). An unbounded window would turn the nightly job into a
  multi-gigabyte, multi-hour pull that cannot finish inside the ack deadline.
  Whole-history pulls belong to the BACKFILL, which has
  `CandleBackfillCheckpoint` precisely so it can be resumed.
- **Self-chains**, bounded by `MAX_CHAIN_DEPTH = 20`. That bound is the
  termination proof and `shouldChainAnotherBatch` consults no database, clock
  or queue. Six other conditions only end it sooner: rate-limited (a fresh link
  re-arms the breaker into the same wall), entitlement/auth (deterministic),
  `symbols`-scoped (a finite manual target), nothing stamped (the runaway
  shape), **rotation wrapped**, and both legs short.
- **`rotationWrapped` is this job's version of "the queue drained".** Unlike
  `stock-document-extract`, a processed row here does not LEAVE the selected
  set — it moves to the back of a stale-first queue — so a short page can never
  be the drained signal. Comparing the page's OLDEST marker against
  `chainStartedAt` (pinned on link 1 and forwarded) detects the wrap and ends
  the chain instead of spending its remaining links re-fetching rows this same
  chain synced twenty minutes ago.

#### Leg (d), and why `date` is not `asOf`

`FxRate.date` is the SESSION day; `asOf` is the observation moment. A USDINR
rate read at 11:00 IST on the calendar day AFTER the US close still DESCRIBES
that session, and stamping it with the observation day would shift every
converted portfolio value by a day. The rate comes from
`getExchangeRate("USD","INR")` (Yahoo) and is stored with `source: "YAHOO"` —
Tiingo's FX endpoints are a separate entitlement we have NOT probed, and
claiming `TIINGO` for a rate Yahoo supplied would be a lie in the one column
whose entire purpose is provenance. A null/zero/negative rate writes NOTHING: a
fabricated rate is worse than a stale one.

A rate IS written on a US market holiday, and that is correct — USDINR trades
on days the US equity market is shut, so the row is a true statement about a
currency, not a claim that a session happened. No US holiday calendar is
consulted anywhere in this job: it fetches a trailing WINDOW and writes
whatever bars come back, so a holiday is simply a day with no bar.

#### Health is judged PER LEG

`reportJobOutcome` lives in a `finally`, so an idle run emits 0/0 rather than
nothing (`notify_no_data` is true, and a monitor that has never been green is a
monitor somebody mutes). But a TOTAL hides a dead leg: a NAV leg that 403s
while the EOD leg writes 70,000 bars leaves the run's totals magnificent.
`judgeUsEodHealth` therefore judges each leg on its own attempted-vs-written
pair and names the failure in `skippedReason` — and every counter it reads is
incremented AFTER the call it counts, because a counter incremented BEFORE its
call reports a full number for a source that 403s every request (MONEY-1255).
"No US instruments selected at all" is called out explicitly rather than
passing as healthy-and-idle: it means the Tiingo instrument sync has never
populated `market: "US"`, which reads identically to a fully-drained queue
unless somebody says so.

The route ACKs **200** even on a throw. Every failure class here is either
deterministic (entitlement, token) or made worse by a retry (rate limit), and a
redelivery spends a second copy of an unobservable quota; transient per-symbol
failures are healed for free by the trailing window. The freshness monitor, not
Pub/Sub's retry, is what notices a dead job.

This job READS `InstrumentMapping` and writes only its own rotation marker. It
never calls `syncInstruments`, so the exchange-scope hazard that would
deactivate the Indian universe does not apply here.

Pure decisions live in `us-eod-sync-logic.ts` (no Prisma, no client, no clock);
`us-eod-sync.ts` does I/O only.

### Investor Rollup Data (system-level, no userId) — MONEY-789 (B4)

```typescript
{
  now?: string;               // Override "now" for replay/tests (ISO string)
  activeWindowDays?: number;  // Active-user lookback (default: 14)
  decayAfterDays?: number;    // Idle-days before concept mastery fades (default: 60)
}
```

Nightly Cloud Scheduler trigger (`investor-rollup-daily`, 21:30 UTC = 03:00 IST).
Active users = distinct userId from `UserEvent` ∪ `Trade` ∪ `Holding` updated in
the window. Per user (best-effort, one failure never aborts the batch): derive a
`PortfolioBehaviorSnapshot`, drift the `InvestorProfile`, decay stale
`ConceptMastery`, delete-then-create `PortfolioInsight` rows (incl. a
`fire_projection`), and `logAiDecision({ decisionType: "NUDGE" })`. The route ACKs
200 even on a throw. Pure math is in `investor-rollup-logic.ts` (unit-tested);
the I/O orchestration is in `investor-rollup.ts`.

---

## Logging — never print an error object raw (MONEY-1209)

`workers/src` has ~459 console calls and any of them can be handed a
ky/got/axios error. Those errors carry the credentialed request on their own
enumerable properties (`request`, `options`, `config`, `response`), so
`console.error("[job] failed:", err)` used to print live NSE session cookies
(`ak_bmsc`, `bm_mi`, `bm_sz`) into prod Cloud Logging, where they are retained
and indexed.

`log-boundary.ts` fixes this at the transport instead of at the call sites:
`installLogRedaction()` runs as the first statement of `index.ts` and routes
every argument of `console.log` / `console.warn` / `console.error` through
`redactSensitive` from `@usemoney/utils/log-redaction`.

Consequences worth knowing:

- **Keep logging errors normally.** `console.error("[job] failed:", err)` is
  still the right call; you do not need to hand-pick fields, and hand-picking is
  in fact worse — it is how `err.message` with an interpolated cookie gets past
  a reviewer.
- **The boundary must stay first in `index.ts`.** Anything that logs before it
  logs unredacted, and boot-time failures are exactly the errors that still have
  their headers attached. `workers/__tests__/log-boundary.test.ts` asserts the
  ordering against the file on disk.
- **`@usemoney/logger` (pino) is a SEPARATE path** — it writes JSON straight to
  its own stream and never touches `console`. It is redacted in
  `packages/logger/src/config.ts`, not here.
- **`console.error` never throws now.** A failed write (EPIPE on shutdown) is
  swallowed rather than taking down the job it was only reporting on.

---

## Processing Pattern

Each processor follows this pattern:

1. Update `BackgroundJob` status to `PROCESSING`
2. Run business logic (from `@usemoney/core`)
3. Update `BackgroundJob` status to `COMPLETED` or `FAILED`

**HTTP Response Codes:**

- `200` = Success -> Pub/Sub acknowledges the message
- `500` = Failure -> Pub/Sub retries with exponential backoff

---

## Commands

```bash
# Dev (Hono server with hot reload)
yarn dev

# Build
yarn build

# Production
yarn start

# Type check
yarn type-check

# Run tests
yarn test
```

---

## Environment Variables

```bash
# Server
PORT=8081           # HTTP port (default: 8081)
NODE_ENV=production # Environment

# Database
DATABASE_URL=mongodb+srv://...

# Redis (caching -- used by @usemoney/core)
REDIS_URL=redis://localhost:6379

# Market Data (system-level, for instrument sync)
ZERODHA_SYSTEM_API_KEY=<api-key>  # For fetching instrument master dump

# Cloud Run
CLOUD_RUN_URL=https://...         # Required for OIDC token verification

# GCP (for Pub/Sub, GCS)
GCP_PROJECT_ID=<project-id>

# Document AI (MONEY-783, stock-document-extract). Optional: when PROCESSOR_ID is
# unset the worker falls back to pdf-parse, so it works pre-provisioning.
DOCUMENT_AI_PROCESSOR_ID=<processor-id>  # Document OCR processor id
DOCUMENT_AI_LOCATION=us                  # processor region (default: us)

# US price backbone (MONEY-980 / MONEY-1262, us-eod-sync). The client THROWS
# when the key is absent rather than fetching unauthenticated, so a missing
# secret is a loud failure, not a job that quietly writes nothing.
TIINGO_API_KEY=<token>            # Secret Manager: TIINGO_API_KEY_{QA,PROD}
TIINGO_PLAN=COMMERCIAL            # COMMERCIAL (20k/hr) | REDISTRIBUTION (80k/hr).
                                  # PLAIN env var, not a secret: it names which
                                  # ceilings to obey and an operator must read it
                                  # at a glance. Unset/unrecognised resolves to
                                  # COMMERCIAL — the LOWER pair — because guessing
                                  # high walks a run into a 429 wall mid-universe
                                  # while guessing low only runs slower. Set
                                  # EXPLICITLY in both cloudbuild specs anyway:
                                  # "absent" and "explicitly commercial" must not
                                  # be one state (MONEY-1214).

# Pull subscriber (local dev only)
ENABLE_PULL_SUBSCRIBER=true       # Enable pull mode for local development
```

On GCP Cloud Run, `DATABASE_URL` and `REDIS_URL` are injected as secrets from
Secret Manager.

---

## Deployment

### Single-Command Setup (Recommended)

```bash
# Full setup: db push + pubsub + scheduler + Cloud Build deploy
./scripts/ops/setup-infra.sh qa           # QA
./scripts/ops/setup-infra.sh prod         # Production

# Selective steps
./scripts/ops/setup-infra.sh qa --step 1  # Only db push
./scripts/ops/setup-infra.sh qa --from 2  # Pubsub + scheduler + deploy
./scripts/ops/setup-infra.sh qa --skip-deploy  # Steps 1-3 only
```

See `docs/reference/scripts-reference.md` for full documentation.

### First-Time GCP Setup

```bash
# One-time: enable APIs, create SA, grant IAM roles, create secrets
./workers/scripts/gcp-setup.sh
```

### Direct Cloud Build (no local Docker)

```bash
gcloud builds submit --config=workers/cloudbuild.qa.yaml
gcloud builds submit --config=workers/cloudbuild.prod.yaml
```

### Database Seeding

```bash
# Multi-environment seeding (from repo root)
./scripts/seed-env.sh qa    # QA only
./scripts/seed-env.sh prod  # Prod only
./scripts/seed-env.sh all   # Both
```

---

## What's Been Completed

- [x] Hono HTTP server (port 8081)
- [x] All 44 job routes + processors
- [x] Pub/Sub push message parser
- [x] OIDC token verification middleware
- [x] Pull subscriber for local dev
- [x] Notification helpers
- [x] Docker configuration with health check
- [x] Cloud Build pipelines (QA, Prod)
- [x] Pub/Sub setup script (44 topics + dead-letter)
- [x] Deploy script (Cloud Run Service)
- [x] Datadog APM integration (dd-trace sidecar)
- [x] PDF report rendering (tax, risk, portfolio statement)
- [x] Document embeddings
- [x] GCS utilities
- [x] Structured logging with @usemoney/logger

---

## What Needs to Be Done

- [x] Dead letter topic handling
- [x] Message deduplication (idempotency)

### Dead-letter handling (MONEY-1204)

`setup-pubsub.sh` has attached a dead-letter policy to every worker push
subscription since MONEY-841: after `--max-delivery-attempts=5` a message is
parked on `dead-letter-${ENV}`. That half worked — the retry storm stopped, and
so did any notice that a job had failed permanently, because **nothing
subscribed to the topic** and parked messages aged out after 7d unseen.

`dead-letter-${ENV}-push → /jobs/dead-letter` now closes it
(`processors/dead-letter-consumer.ts` + `-logic.ts`, `routes/dead-letter.ts`):

- **Logs** one structured line: source subscription, the recovered job name
  (`price-sync-prod-push` → `price-sync`), source project, the ORIGINAL publish
  time (from `CloudPubSubDeadLetterSourceTopicPublishTime` — `message.publishTime`
  is when Pub/Sub re-published to the DLQ, which would misdate the incident by
  however long the retries took), the delivery count, and a **truncated**
  (2,000-char) **redacted** payload excerpt.
- **Notifies** the founder in-app through the existing `lib/notifications.ts`
  service, type `SYSTEM`. Recipients: `DLQ_ALERT_EMAILS` → `ADMIN_EMAILS` →
  `deepshaswat@gmail.com`.
- **Never auto-retries.** A message here has already been delivered 5 times and
  failed 5 times. Re-running it is how a poison message becomes an infinite
  loop, and the loop would be running on the one queue with no further backstop.
  Requeuing is a human decision taken after the cause is fixed.
- **Never throws, never nacks.** The route returns 200 on every path including
  its own internal failures, and the DLQ subscription has no dead-letter policy
  of its own. A 5xx here would push the message back onto the DLQ.
- **Idempotent on `messageId`** via the shared dedupe store below, so the same
  dead letter delivered twice produces exactly ONE notification. Unlike the
  generic middleware, every dedupe outcome here — completed, in-flight
  elsewhere, store unavailable — results in an ACK; there is no work to lose.

Redaction is local to `dead-letter-consumer-logic.ts` because the repo has no
structural (key-based) redactor to reuse: `@usemoney/utils/error-sanitization`
maps a whole error STRING to a canned user-facing message, which would replace
an entire payload with "Something went wrong". Keys are matched by name
(`*token*`, `*secret*`, `*password*`, `authoriz*`, `signature`, …) and values by
SHAPE (JWTs, `Bearer …`, `mongodb+srv://…`, `sk_live_…`, `AIza…`), so a
`DATABASE_URL` embedded in a free-text field does not sail past the key check.
Depth, array width and key count are all bounded and the walk is cycle-safe.

### Pub/Sub `messageId` idempotency (MONEY-1204)

`app.use("/jobs/*", pubsubDedupeMiddleware)` in `index.ts`, registered AFTER the
OIDC gate — claiming a messageId for an unauthenticated request would let anyone
burn the dedupe key for a real message, a denial-of-job with no credentials.
That middleware is the only truly universal entry point: there is no shared job
wrapper, each route calls `parsePubSubMessage` itself.

- **Marker:** a dedicated `pubsub_message_dedupe` collection reached through
  `prisma.$runCommandRaw`. NOT `MarketDataSyncLog` (5 processors write it) or
  `BackgroundJob` (4 write it) — nine of ~55 job routes between them, and the
  two sets are disjoint, so neither is "the one every job already writes". Both
  are also semantic tables other code reads (MONEY-1189's completeness checks
  aggregate `market_data_sync_logs`), and `BackgroundJob` requires a `userId`
  ObjectId and a `JobType` enum member that a cron sync does not have.
- **Atomicity:** a UNIQUE index on `messageId` makes the INSERT the arbiter.
  Two concurrent deliveries both insert; MongoDB serialises them on the index;
  exactly one wins and the other gets E11000. There is no read-then-write
  window. Note `insert` does NOT fail the command on a duplicate — it reports it
  in `writeErrors[]` — so both that shape and a thrown error are recognised.
- **Leased, not a bare "seen" flag.** A plain seen-marker makes a CRASHED job
  permanently un-retryable. An IN_FLIGHT marker carries a 1h lease (> the 600s
  ack deadline, so a legitimate redelivery of a still-running job cannot steal
  it). While the lease holds, a second delivery gets **409 = nack**, never
  "skip". Once it expires the marker is stealable via a compare-and-swap
  `findAndModify` filtered on the observed lease, so only one stealer wins.
- **Outcomes:** COMPLETED → ack + `duplicate:true` log, no re-run. FAILED →
  re-claimable (Pub/Sub keeps its remaining attempts). Non-2xx or a throwing
  handler releases the claim as FAILED so one transient error does not become an
  hour of 409s.
- **Fail-OPEN.** A store outage returns `RUN_UNTRACKED` and the job runs. Dedupe
  is an optimisation over an already-correct at-least-once system; failing
  closed would turn a Mongo blip into a total job outage.
- **No synthetic ids.** Bodies without a real Pub/Sub `messageId` (local dev,
  manual curl, the pull subscriber) are never claimed —
  `lib/message.ts::getMessageId` synthesises `local-${Date.now()}`, and deduping
  on that would make two triggers in the same millisecond collide.
- **Kill switch:** `PUBSUB_DEDUPE=off`. Lease override:
  `PUBSUB_DEDUPE_LEASE_MS`. TTL: markers expire after 14d (2x Pub/Sub's 7d
  retention — a marker reaped early would let a redelivery re-run the job).

---

## Test Coverage

**Coverage counts live in [`../TEST-COVERAGE.md`](../TEST-COVERAGE.md) (single
source of truth — MONEY-838).** The table below covers only the original core jobs; `src/` now has ~120 source files.

| Source File                                    | Test File                                                    | Test Cases | Status |
| ---------------------------------------------- | ------------------------------------------------------------ | ---------- | ------ |
| `routes/health.ts`                             | `__tests__/workers/health.test.ts`                           | 9          | PASS   |
| `lib/message.ts`                               | `__tests__/workers/message.test.ts`                          | 51         | PASS   |
| `lib/notifications.ts`                         | `workers/__tests__/lib/notifications.test.ts`                | 31         | PASS   |
| `lib/pull-subscriber.ts`                       | `workers/__tests__/lib/pull-subscriber.test.ts`              | 59         | PASS   |
| `processors/*` (all)                           | `__tests__/workers/processors.test.ts`                       | 47         | PASS   |
| `processors/pairing.ts`                        | `__tests__/workers/processor-pairing.test.ts`                | 84         | PASS   |
| `processors/import.ts`                         | `__tests__/workers/processor-import.test.ts`                 | 161        | PASS   |
| `processors/sync.ts`                           | `__tests__/workers/processor-sync.test.ts`                   | 98         | PASS   |
| `processors/price-sync.ts`                     | `__tests__/workers/processor-price-sync.test.ts`             | 47         | PASS   |
| `processors/sector-enrichment.ts`              | `__tests__/workers/processor-sector-enrichment.test.ts`      | 26         | PASS   |
| `processors/mf-metadata-sync.ts`               | `__tests__/workers/mf-metadata-sync.test.ts`                 | 19         | PASS   |
| `processors/research.ts`                       | `__tests__/workers/research.test.ts`                         | 21         | PASS   |
| `processors/instrument-sync.ts`                | `__tests__/workers/instrument-sync.test.ts`                  | 15         | PASS   |
| `processors/mf-sync.ts`                        | `__tests__/workers/mf-sync.test.ts`                          | 12         | PASS   |
| `index.ts` + `index-auth-logic.ts` (OIDC skip) | `workers/__tests__/auth-middleware.test.ts`                  | 21         | PASS   |
| `index.ts` + `routes/*` + `lib/*`              | `__tests__/workers/integration.test.ts`                      | 27         | PASS   |
| `processors/document-process.ts`               | `__tests__/workers/document-process.test.ts`                 | 55         | PASS   |
| `processors/stock-document-extract-logic.ts`   | `__tests__/workers/processor-stock-document-extract.test.ts` | 30         | PASS   |
| `lib/embeddings.ts`                            | `__tests__/workers/embeddings.test.ts`                       | 26         | PASS   |
| `lib/report-renderer.ts`                       | `__tests__/workers/report-renderer.test.ts`                  | 24         | PASS   |
| `lib/gcs.ts`                                   | `__tests__/workers/gcs.test.ts`                              | 28         | PASS   |
| `processors/roast.ts`                          | `__tests__/workers/processor-roast.test.ts`                  | 40         | PASS   |
| `routes/roast.ts`                              | `__tests__/workers/route-roast.test.ts`                      | 32         | PASS   |
| `processors/investor-rollup-logic.ts`          | `__tests__/workers/processor-investor-rollup-logic.test.ts`  | 30         | PASS   |

> `processors/investor-rollup.ts` (I/O seam) + `routes/investor-rollup.ts` are
> best-effort / never-throw and untested at this layer — only the pure
> `investor-rollup-logic.ts` math (which the processor calls) is covered, same
> posture as `login-briefing.ts`.

> MONEY-783 — `processors/stock-document-extract.ts` (I/O seam),
> `routes/stock-document-extract.ts` (ACK-200-on-throw) and `lib/docai.ts`
> (never-throw, degrades-to-null Document AI client) are untested at this layer;
> only the pure `stock-document-extract-logic.ts` query/path helpers (which the
> I/O processor calls) are covered — same posture as the embed I/O processor.

See [`../TEST-COVERAGE.md`](../TEST-COVERAGE.md) for the full report.

> **Rule:** When adding tests for workers, update `TEST-COVERAGE.md` in the repo
> root.

---

## Restrictions

- Workers are stateless
- All job state stored in MongoDB (BackgroundJob model)
- Log all processing steps
- Handle failures gracefully (500 = retry)
- Only Pub/Sub (with OIDC token) can invoke endpoints in production

---

_Last Updated: August 2026_

---

## MONEY-1314 — `stock-document-parse` is retired, and the route is still here

All four crons (`stock-document-parse-{daily,morning,midday,evening}`) are in
`OLD_SCHEDULER_PREFIXES`. The PROCESSOR and ROUTE deliberately survive: the old
lane self-chains up to 20 links, so messages are in flight for up to ~3h20m
after the last cron fires, and deleting the route would 404 them into the
dead-letter queue five deliveries later. Remove them once the chain has
drained.

Its Datadog monitor is REMOVED rather than repointed. `stock-document-ingest`
is event-driven and gated by a flag that ships off, so a freshness monitor with
`notify_no_data: true` would sit in NO DATA from day one — the state
`apply-monitors.sh`'s own comments warn about. The row to add, and the deploy
to add it in, are written down there.

Operational sequence: `docs/reference/doc-ingest-runbook.md`.
Measured conversion findings: `docs/reference/doc-convert-decision.md`.
Population, batch path and cost: `docs/reference/doc-ingest-population.md`.
