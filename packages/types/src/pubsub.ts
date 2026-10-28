// ============================================
// Pub/Sub Types & Constants
// ============================================
// Shared between web app (publisher) and workers (consumer)

// Topic base names (suffixed with env at publish time via getTopicName)
export const PUBSUB_TOPICS = {
  TRADE_PAIRING: "trade-pairing",
  CSV_IMPORT: "csv-import",
  BROKER_SYNC: "broker-sync",
  INSTRUMENT_SYNC: "instrument-sync",
  PRICE_SYNC: "price-sync",
  INTRADAY_SYNC: "intraday-sync",
  SECTOR_ENRICHMENT: "sector-enrichment",
  STOCK_RESEARCH: "stock-research",
  MF_SYNC: "mf-sync",
  MF_METADATA_SYNC: "mf-metadata-sync",
  MF_NAV_PROPAGATE: "mf-nav-propagate",
  /** MONEY-1205 - MFAPI.in NAV-history backfill, moved OFF the request path.
   *  `getMfNavHistory` used to run the whole backfill inline (609 sequential
   *  upserts, 55-83s measured on prod during a real page view) the first time
   *  anyone opened a fund. It now returns what the DB has and publishes here.
   *  TWO publishers, and the first is the one that actually seeds the universe:
   *  Cloud Scheduler `mf-nav-backfill-daily` (23:00 IST, after mf-sync at 22:30)
   *  posts `{universe:true}` straight to the topic; the cold-read path in
   *  `@usemoney/core/market-data` posts `{schemeCodes:[code]}` on demand.
   *  Worker: workers/src/processors/mf-nav-backfill.ts */
  MF_NAV_BACKFILL: "mf-nav-backfill",
  PEERS_SYNC: "peers-sync",
  DOCUMENT_PROCESS: "document-process",
  PORTFOLIO_ROAST: "portfolio-roast",
  /** MONEY-553 - async deep stock/MF comparison. Server action creates a
   *  QUEUED ComparisonSession (reserving credits), publishes here; the worker
   *  runs the mf-comparison / multi-comparison skill via the ResearchAgent. */
  COMPARISON_ANALYSIS: "comparison-analysis",
  /* MONEY-1205 — `fund-composition-sync` was REMOVED here.
   *
   * It was declared, created by workers/scripts/setup-pubsub.sh, consumed by
   * workers/src/processors/fund-composition.ts — and published by NOTHING, with
   * no scheduler entry. Refresh was therefore 100% page-view-driven, which is
   * how a single ETF page view came to spend a Gemini call.
   *
   * It was deleted rather than wired because wiring it would industrialise a
   * measured falsehood: six months of re-extraction returned the same
   * 2024-04/05/06 content for all 111 stored funds, and the processor's own
   * `needsExtraction` gated on `extractedAt` — the same clock field that can
   * never go stale. A nightly job on that basis is ~446 ETFs x 1 Gemini
   * "advanced" call producing two-year-old holdings on a schedule. The AI
   * reading now runs only when a user explicitly asks for it; the authoritative
   * path is the real AMC disclosure pipeline (`mf_portfolio_holdings`).
   *
   * `proactive-analysis` was removed in the same change for the same reason
   * (declared + topic-created, no processor, no route, no publisher at all).
   * The guard that keeps this from recurring is
   * packages/core/__tests__/pubsub/topic-publisher-coverage.test.ts. */
  BHAVCOPY_SYNC: "bhavcopy-sync",
  BSE_ANNOUNCEMENTS_SYNC: "bse-announcements-sync",
  NEWSLETTER_PUBLISH: "newsletter-publish",
  L3_ANALYSIS: "l3-analysis",
  LOGIN_BRIEFING: "login-briefing",
  // FINANCIAL_DATA_SYNC ("financial-data-sync") was REMOVED here — MONEY-1220.
  //
  // I first kept the constant with a "retired" comment, reasoning that the route
  // and the stale-delete list might want to name it. They do not: the route is
  // mounted by path string and the delete list holds a scheduler NAME. Leaving
  // it declared made `topic-publisher-coverage.test.ts` fail, correctly — a
  // topic that is declared, created and consumed but has no publisher and no
  // scheduler entry is one nothing can ever put a message on, which is
  // indistinguishable from a topic whose publisher was lost in a refactor.
  //
  // Tickertape 403s our Cloud Run egress. Statements moved to XBRL_PROJECTION,
  // ratios to XBRL_RATIOS, both derived from our own archived NSE filings.
  // `workers/src/routes/financial-data-sync.ts` still exists and ACKs, because
  // the live scheduler survives until someone runs setup-scheduler.sh.
  NEWS_SYNC: "news-sync",
  FILINGS_SYNC: "filings-sync",
  /* MONEY-1205 — these four were LIVE but undeclared: created by
   * workers/scripts/setup-pubsub.sh, routed in workers/src/index.ts and
   * published by Cloud Scheduler, while `PUBSUB_TOPICS` had never heard of
   * them. That works only because the scheduler publishes the literal topic
   * name; the moment anyone needs a code publisher, or greps this object to
   * find out what exists, the registry is wrong. The mirror image of the dead
   * `fund-composition-sync` topic above, and caught by the same guard
   * (packages/core/__tests__/pubsub/topic-publisher-coverage.test.ts, which
   * also asserts every scheduler entry names a DECLARED topic — a typo there
   * publishes into the void). */
  /** MONEY-1113 P10 F1 — company financials from NSE's own XBRL filings. */
  XBRL_SYNC: "xbrl-sync",
  /** MONEY-1220 — projects archived filings into StockFinancials. */
  XBRL_PROJECTION: "xbrl-projection",
  /** MONEY-1220 — derives all 23 owned StockRatios columns from those filings. */
  XBRL_RATIOS: "xbrl-ratios",
  /** MONEY-1105 P8a — AMC monthly portfolio disclosures (the authoritative
   *  source the AI fund-composition panel is only a fallback for). */
  MF_PORTFOLIO_SYNC: "mf-portfolio-sync",
  /** MONEY-1187 P11 — NSE exchange circulars. */
  CIRCULARS_SYNC: "circulars-sync",
  /** MONEY-1098 — daily events-calendar population (UpcomingEvent). */
  EVENTS_SYNC: "events-sync",
  CHARTINK_STRATEGY_SYNC: "chartink-strategy-sync",
  INTENT_LEARNING: "intent-learning",
  STRATEGY_SCAN: "strategy-scan",
  STOCK_DOCUMENT_SYNC: "stock-document-sync",
  /** MONEY-783 - Document AI / pdf-parse text extraction of PENDING stock PDFs.
   *  Sits between stock-document-sync (writes PENDING PDFs) and
   *  stock-document-embed (needs READY + non-null textContent); chains to embed. */
  STOCK_DOCUMENT_EXTRACT: "stock-document-extract",
  STOCK_DOCUMENT_EMBED: "stock-document-embed",
  /** MONEY-1255 - Gemini reads FIGURES out of a filed PDF into
   *  `document_financial_extracts`.
   *
   *  A SEPARATE LANE from STOCK_DOCUMENT_EXTRACT, which is text-for-RAG. The
   *  two run on the same documents and neither implies the other: a scanned
   *  annual report yields good retrieval text and no reliable statement table,
   *  while a machine-readable filing parses to figures whether or not anyone
   *  has embedded it. `StockDocument` carries one status per lane
   *  (`processingStatus` / `parseStatus`) for the same reason.
   *
   *  Two consumers: an independent third reading that can ADJUDICATE
   *  XBRL-vs-vendor disagreements for companies we already cover, and the only
   *  source of figures at all for the ~821 symbols with no XBRL filing. */
  STOCK_DOCUMENT_PARSE: "stock-document-parse",
  /** MONEY-1314 - ONE document per message: convert once, then both readings.
   *
   *  The batch lanes above each re-open the same PDF on their own schedule.
   *  This one converts with `pdf-inspector` into a `${gcsPath}.md` sidecar that
   *  every later pass reuses, so conversion is paid once per DOCUMENT rather
   *  than once per parse — measured 1.9-4.5 ms/page, noise against the 600s ack
   *  deadline, and ~0.4 MB RSS/page, which is what bounds concurrency.
   *
   *  FOUR LANES (`workers/src/processors/stock-document-ingest-logic.ts`), and
   *  the two reading lanes deliberately do NOT cover each other: MARKDOWN sends
   *  page-selected text (~10k input tokens against a whole PDF's 258 tokens PER
   *  PAGE, with a cacheable prefix and no size ceiling); VISION sends the whole
   *  PDF and is the retry, plus the only lane a scanned document has — but it is
   *  capped at Gemini's 50 MB limit. So a document that is BOTH scanned AND over
   *  50 MB has no lane at all. That is a NAMED terminal status (`UNREADABLE`),
   *  countable in the outcome report, rather than a mysterious per-document
   *  failure re-selected on every forced pass forever.
   *
   *  ONE PLAIN PUSH SUBSCRIPTION — deliberately NO `--message-filter`. Pub/Sub
   *  filters read `attributes.*` only, and every publisher in this repo calls
   *  `topic.publishMessage({ json })` (or `{ data }`), neither of which sets any
   *  attribute. A filtered subscription would therefore match zero messages and
   *  DROP them — the failure would look exactly like a quiet queue. */
  STOCK_DOCUMENT_INGEST: "stock-document-ingest",
  /** MONEY-1255 - projects graded `document_financial_extracts` rows into
   *  `stock_financials`.
   *
   *  Runs nightly whether or not it is ARMED: disarmed it still reads, grades
   *  its own coverage and reports what it WOULD write, which is how the
   *  operator sees the pipeline is alive before trusting it with the one-way
   *  door. `DOC_FINANCIALS_APPLY` (literal string "true") gates the writes;
   *  `StockFinancials` carries no `source` in its unique key, so the first
   *  write to a period destroys whatever it replaced. */
  DOCUMENT_FINANCIALS_PROJECTION: "document-financials-projection",
  /** MONEY-840/844 - weekly corporate-actions ingestion (splits / bonuses /
   *  dividends / buybacks). Scrapes Screener + NSE, normalizes, upserts the
   *  `CorporateAction` table (history-preserving) and archives a per-symbol JSON
   *  snapshot to GCS. Feeds the FIFO pairing cost-basis adjustment. Worker:
   *  workers/src/processors/corporate-actions-sync.ts */
  CORPORATE_ACTIONS_SYNC: "corporate-actions-sync",
  RESEND_CONTACT_SYNC: "resend-contact-sync",
  SPARKLINE_SYNC: "sparkline-sync",
  /** MONEY-240 A - confirmation-sheet preview-plan worker fallback */
  RESEARCH_PREVIEW_PLAN: "research-preview-plan",
  /** MONEY-301 - weekly NSE index constituent sync (Nifty 50 / 100 / 500 /
   *  Midcap 150 / Smallcap 250 / Bank Nifty / Nifty IT). Drives the screener
   *  Index filter once populated; the static + mcap-rank fallback in
   *  `apps/web/lib/screener/index-constituents.ts` covers the gap. */
  INDEX_CONSTITUENT_SYNC: "index-constituent-sync",
  /** MONEY-1189 - daily NSE surveillance sync (ASM + GSM). Cron: 20:15 IST,
   *  after the exchange publishes the day's lists. MUST run daily: both
   *  endpoints serve only the CURRENT list, so a missed day can never be
   *  backfilled. Worker: workers/src/processors/surveillance-sync.ts */
  SURVEILLANCE_SYNC: "surveillance-sync",
  /** MONEY-1108 (P8d) - daily FII/DII institutional cash-market flows from
   *  NSE /api/fiidiiTradeReact. Cron: 20:30 IST weekdays, after the exchange
   *  publishes the day's provisional figures. MUST run daily for the same
   *  reason as SURVEILLANCE_SYNC: the endpoint takes no date parameter and
   *  serves only the CURRENT reading, so a missed day can never be
   *  backfilled. Worker: workers/src/processors/institutional-flow-sync.ts */
  INSTITUTIONAL_FLOW_SYNC: "institutional-flow-sync",
  /** MONEY-1198 - the EXCHANGE'S OWN top gainers/losers (NSE
   *  /api/live-analysis-variations) plus the live whole-market index snapshot
   *  (/api/allIndices). Cron: every 3 minutes, 09:15-15:30 IST weekdays — an
   *  INTRADAY poll, unlike every other feed here, because the datum is "what is
   *  moving right now" and Discover was serving the previous session's ranking
   *  as "today". CANNOT be backfilled: neither endpoint takes a date parameter
   *  and both serve only the CURRENT snapshot, so the schedule is the only
   *  thing that accrues history. Whole-market only — ONE ~35 KB response carries
   *  all seven of NSE's buckets, so there is no per-symbol fan-out and no
   *  rate-limit exposure of the kind that has bitten us before.
   *  Worker: workers/src/processors/market-movers-sync.ts */
  MARKET_MOVERS_SYNC: "market-movers-sync",
  /** MONEY-1106 (Data Engine P8b) - official Indian macro series (CPI, WPI,
   *  repo, CRR/SLR, forex reserves, call money) from RBI's National Summary
   *  Data Page, which republishes the Weekly Statistical Supplement plus
   *  MOSPI's CPI and the OEA's WPI. Two crons: `macro-sync-weekly` (Sat 08:00
   *  IST, after Friday's WSS release) and `macro-sync-midweek` (Tue 08:00 IST)
   *  — the second is a real second chance, not redundancy: the forex-reserves
   *  page publishes a SINGLE "as on" column and so cannot self-heal the way the
   *  rolling rates/prices pages do. Prod-only — QA replays the archived HTML
   *  from `feeds/RBI/` and also receives `macro_series` via
   *  sync-prod-to-qa.sh. Worker: workers/src/processors/macro-sync.ts */
  MACRO_SYNC: "macro-sync",
  /** MONEY-408 - RSS-based news ingestion. Cron: every 5min market hours,
   *  every 15min off-hours. Worker: workers/src/processors/news-rss-sync.ts */
  NEWS_RSS_SYNC: "news-rss-sync",
  /** MONEY-408 - alert engine evaluator. Cron: every minute market hours,
   *  every 5min off-hours. Worker: workers/src/processors/alert-evaluator.ts */
  ALERT_EVALUATOR: "alert-evaluator",
  /** MONEY-406 - weekly strategy backtest stats sync, populates
   *  `strategies:stats:all` in Redis for the Browse card grid.
   *  Cron: Sunday 8:00 PM IST. */
  STRATEGY_STATS_SYNC: "strategy-stats-sync",
  /** MONEY-391 - async account deletion. Server action verifies OTP +
   *  writes DeletedUserAudit (status=PENDING), then publishes here.
   *  Worker locks Clerk user, snapshots, cancels Dodo, hard-deletes
   *  user DB rows, sends confirmation email, flips audit
   *  status=LOCKED. */
  ACCOUNT_DELETION: "account-deletion",
  /** MONEY-144 - hourly sweep that purges Clerk users 24h after their
   *  account was locked. Query: DeletedUserAudit where status=LOCKED
   *  and clerkDeleteScheduledFor <= now. Calls Clerk users.deleteUser,
   *  flips status=COMPLETED, stamps clerkUserDeletedAt. Cron is set up
   *  in scripts/ops/setup-scheduler.sh. */
  CLERK_DELETE_SWEEP: "clerk-delete-sweep",
  /** MONEY-789 (B4) - nightly investor self-learning rollup. Cron triggers it
   *  daily; the worker derives a PortfolioBehaviorSnapshot per active user,
   *  drifts their InvestorProfile, decays stale ConceptMastery, rebuilds
   *  PortfolioInsight rows, and reprojects FIRE. Worker:
   *  workers/src/processors/investor-rollup.ts */
  INVESTOR_ROLLUP: "investor-rollup",
  /** MONEY-1097 (Data Engine P2) - archive-first capture of the whole
   *  analytics-relevant NSE/BSE report set. Walks REPORT_REGISTRY and pushes
   *  every enabled family's bytes through `getFeedAsset` into the GCS feed
   *  archive. Parses NOTHING — NSE prunes its archives (proved with real 404s
   *  on the PR zips for 1995/2000/2010), so capturing the files is urgent and
   *  parsing them (P4) is not. Two crons a night (19:30 + 21:45
   *  IST) so late publishers are still caught; a monthly run covers monthly
   *  families. Worker: workers/src/processors/report-archive-sync.ts */
  REPORT_ARCHIVE_SYNC: "report-archive-sync",

  /** MONEY-1098 (P5.1) — whole-market NSE announcements, deduped vs the BSE leg. */

  NSE_ANNOUNCEMENTS_SYNC: "nse-announcements-sync",

  /** MONEY-1098 (P5.4) — weekly-sharded ownership syncs → ShareholdingPattern + InsiderEvent. */

  OWNERSHIP_SYNC: "ownership-sync",

  /** MONEY-1098 (P5.5) — weekly-sharded NSE annual reports (leg A) + the market-wide integrated-filing-results window (leg B). */

  ANNUAL_REPORTS_SYNC: "annual-reports-sync",

  /** MONEY-1098 (P5.6) — NSE public issues → UpcomingIpo. */

  IPO_SYNC: "ipo-sync",
  /** Content Studio - async Veo + reel render → GCS. apps/content publishes a
   *  RenderJob here; the worker consumes via the `studio-render-<env>-push`
   *  subscription → `/jobs/studio-render` (workers/src/routes/studio-render.ts).
   *  Base name MUST match workers/scripts/setup-pubsub.sh. Resolve the env-
   *  suffixed name with getTopicName(PUBSUB_TOPICS.STUDIO_RENDER) so an unset
   *  PUBSUB_ENV falls back to `-qa` outside production (never `-prod`). */
  STUDIO_RENDER: "studio-render",
  /** MONEY-980 (task 6+7) — the nightly US price backbone, on Tiingo.
   *
   *  FOUR COUNTED LEGS in one job, because they share one upstream, one token
   *  and one rate-limit budget, and splitting them into four topics would make
   *  four jobs race for a quota none of them can see (Tiingo publishes no
   *  remaining-budget header — a 429 is the only feedback channel).
   *
   *    (a) yesterday's EOD bars for ACTIVE US securities  -> `Candle`
   *    (b) US mutual-fund NAVs (published after 00:00 EST;
   *        the NAV rides in the OHLC fields)               -> `Candle`
   *    (c) the corporate-actions delta, DERIVED from the inline
   *        `divCash`/`splitFactor` columns that come free on (a)+(b)
   *        — the dedicated corporate-actions endpoints 403 on our plan —
   *        which invalidates the adjusted-series cache for affected symbols
   *    (d) the USDINR rate for the session                 -> `FxRate`
   *
   *  Cron `0 7 * * 2-6` IST (Tue-Sat), NOT `1-5`: a US session on day D closes
   *  at 16:00 ET, which is 02:30 IST on D+1, so the IST weekday that follows a
   *  US trading day is Tue..Sat. A `1-5` cron would sync Sunday's non-session
   *  and never sync Friday's.
   *
   *  Self-chaining (`chainDepth`), wall-clock-bounded, and it rotates on
   *  `InstrumentMapping.usEodSyncedAt` — ordered ASC, never present in a
   *  `where`. Worker: workers/src/processors/us-eod-sync.ts */
  US_EOD_SYNC: "us-eod-sync",
  /** MONEY-980 — Tiingo US security master -> InstrumentMapping, plus the
   *  EDGAR ticker->CIK join. Must run BEFORE `us-eod-sync`, whose population
   *  (`{market:"US", listingStatus:"ACTIVE"}`) does not exist until it has.
   *  Worker: workers/src/processors/us-instrument-master-sync.ts */
  US_INSTRUMENT_MASTER_SYNC: "us-instrument-master-sync",
  /** MONEY-980 — the hot/cold store's ONLY deleter.
   *
   *  Two rules, one job: a `tier:"LOADED"` row whose `hotLoadedAt` is older
   *  than 30 days, and a `tier:"WINDOW"` row whose bar year has fallen out of
   *  the rolling hot window. Without it `Candle` only ever grows and
   *  `tier` / `hotLoadedAt` / `UsInstrument.hotLoadedYears` are three columns
   *  with no reader.
   *
   *  DESTRUCTIVE, so it is DISARMED unless `CANDLE_EVICT_APPLY=true`, killable
   *  with `CANDLE_EVICT=off`, and it deletes a row only after a cold shard has
   *  been observed to contain a bar with that row's exact natural key.
   *  Route path MUST equal this base name: /jobs/candle-evict.
   *  Worker: workers/src/processors/candle-evict.ts */
  CANDLE_EVICT: "candle-evict",
  /** MONEY-1309 — the 24x7 US news poller.
   *
   *  `*\/2 * * * *`: every 2 minutes, on ALL SEVEN DAYS. The `*` day field is
   *  the point, and it is the one thing that separates this row from the three
   *  above it. Those carry `2-6` because a US session closes 16:00 ET = 02:30
   *  IST on D+1, so the IST weekdays FOLLOWING a US trading day are Tue..Sat —
   *  a fact about the EXCHANGE CALENDAR. News has no exchange calendar: an 8-K
   *  drops on a Sunday, and the stories that move a price hardest are often
   *  filed while the market is shut. `news-sync-market-hours` (the Indian leg)
   *  already carries this correction in its own description.
   *
   *  PROD_ONLY. Tiingo is a PAID METERED api; at 720 runs a day a second
   *  environment is 1,440 against ONE account quota, paced by a MODULE-SCOPE
   *  limiter that is shared inside a process and with nothing across
   *  processes. QA receives `us_news_articles` through sync-prod-to-qa.sh
   *  instead — and NOT `us_news_cursor`, whose watermark would move QA's
   *  window past articles no QA run ever wrote (the `us_edgar_cursor` refusal).
   *
   *  Route path MUST equal this base name: /jobs/tiingo-news-poll.
   *  Worker: workers/src/processors/tiingo-news-poll.ts */
  TIINGO_NEWS_POLL: "tiingo-news-poll",

  /** MONEY-1324 (P17) — AI readings of SEC 8-K/6-K exhibits, from the text
   *  `services/us-fundamentals` already extracted to GCS.
   *
   *  ONE TOPIC, TWO MESSAGE SHAPES, the arrangement `broker-sync` uses for its
   *  shard fan-out (MONEY-841) and `stock-document-parse` for its self-chain:
   *
   *    {"mode":"sweep"}      Cloud Scheduler `us-filing-insight-sweep-${ENV}`
   *                          every 10 minutes. Diffs the cohort against
   *                          `us_filing_insights` and publishes one message per
   *                          owed document BACK ONTO THIS TOPIC.
   *    {"documentId":"..."}  one document, one model call, one upserted row.
   *
   *  So it has BOTH publishers `topic-publisher-coverage` recognises — a Cloud
   *  Scheduler entry and a code publisher (`filing-insight-sweep.ts`) — and
   *  neither is decorative: the scheduler starts each tick and the fan-out is
   *  what actually addresses a document.
   *
   *  The SWEEP IS THE RETRY CHANNEL, because the route ACKs 200 on every path
   *  including a throw and Pub/Sub therefore never redelivers. A leaf failure
   *  writes `insightStatus: FAILED` and the sweep re-selects it after a
   *  cooldown; MONEY-1314's black hole was a status no query selected.
   *
   *  Route path MUST equal this base name: /jobs/us-filing-insight.
   *  Worker: workers/src/processors/us-filing-insight.ts (leaf) +
   *  workers/src/processors/filing-insight-sweep.ts (fan-out). */
  US_FILING_INSIGHT: "us-filing-insight",

  /** MONEY-1520 — claimed SEC filings -> `InstrumentEvent`. The ONE topic in
   *  this table whose PUBLISHER is Python and whose CONSUMER is TypeScript.
   *
   *  It replaces a cross-service HTTP hop that answered 404 on every call from
   *  the day it shipped: `services/us-fundamentals` POSTed to
   *  `/internal/events` on `stockbook-workers-{env}`, which carries
   *  `run.googleapis.com/ingress: internal` while the producer has no VPC
   *  egress — so the request left over the public internet and Cloud Run
   *  refused it at the EDGE, before Hono and before `jobsAuth` (which has no
   *  404 path and would have answered 401). `instrument_events` held 4,019 rows
   *  and not one was `SEC_EDGAR`.
   *
   *  Pub/Sub push is not external traffic, which is exactly why the ~55 other
   *  job routes reach that same service without trouble. Nothing else changed:
   *  the message body IS the request body the route already validated, and the
   *  route already decoded a push envelope.
   *
   *  DO NOT confuse this with the `instrument-event-{env}` topic
   *  `packages/services/src/events.service.ts` declines to build. That one is
   *  the LAKE SINK's — a topic for the silver append, which stays a Mongo
   *  watermark drain (`scripts/jobs/event-lake-sink.ts`). This one is the
   *  producer's transport, it has a consumer, and its consumer writes Mongo.
   *
   *  It is NOT in `EDGAR_TOPICS` in setup-pubsub.sh, for the same reason
   *  `us-filing-insight` is not: that array's push endpoints point at
   *  `us-fundamentals-{env}`, and this one is consumed by the WORKERS.
   *
   *  Route path MUST equal this base name: /jobs/us-filing-events.
   *  Publisher: services/us-fundamentals app/jobs/detect.py `_emit_events`.
   *  Worker: workers/src/processors/internal-events.ts */
  US_FILING_EVENTS: "us-filing-events",

  // ── US fundamentals — SEC EDGAR (MONEY-979) ─────────────────────────────
  //
  // Consumed by `services/us-fundamentals/`, a PYTHON Cloud Run service, so
  // nothing in TypeScript imports these constants to publish. They are declared
  // here anyway, and the reason is the guard that caught their absence:
  // `topic-publisher-coverage` asserts every Cloud Scheduler entry targets a
  // topic this file declares, precisely so a scheduler cannot publish into a
  // name no constant knows — `setup-scheduler.sh` had three entries pointing at
  // `edgar-detect` / `edgar-evict` while this table had never heard of either.
  //
  // Being listed here is what makes the scheduler, `setup-pubsub.sh` and the
  // service's own route table three statements of ONE fact instead of three
  // that can drift apart. The route path MUST equal the base name: Pub/Sub
  // builds the push endpoint as `${SERVICE_URL}/jobs/${BASE_TOPIC}`, so a route
  // named anything else 404s every delivery, which Pub/Sub retries five times
  // and then dead-letters, silently (MONEY-1257).

  /** MONEY-979 — the minutely `getcurrent` walk and the hourly EFTS reconcile
   *  (same route, `{"mode":"efts"}`). Inserts into `us_filings` and fans each
   *  new filing out to its parser topic. Handler: services/us-fundamentals
   *  app/jobs/detect.py */
  EDGAR_DETECT: "edgar-detect",

  // One parser per FORM CLASS rather than one `edgar-parse` with a
  // discriminator: a poison 13F cannot stall Form 4 ingestion, and each class
  // gets its own backlog, dead-letter accounting and zero-write monitor.
  /** Forms 3/4/5 -> us_insider_transactions. */
  EDGAR_PARSE_OWNERSHIP: "edgar-parse-ownership",
  /** 13F-HR/A -> us_13f_filings + us_13f_holdings, and the CUSIP-map leg. */
  EDGAR_PARSE_13F: "edgar-parse-13f",
  /** SCHEDULE 13D/G (and legacy SC 13D/G) -> us_beneficial_ownership. */
  EDGAR_PARSE_13DG: "edgar-parse-13dg",
  /** 8-K and 6-K exhibits -> us_filing_documents (text to GCS). */
  EDGAR_PARSE_8K: "edgar-parse-8k",
  /** 10-K/10-Q/20-F/40-F -> us_fundamentals, point-in-time. */
  EDGAR_PARSE_FINANCIALS: "edgar-parse-financials",

  /** MONEY-979 — the 13F hot/cold evictor, the only route in that service that
   *  DELETES. Archives a quarter's holdings to a GCS shard, RE-READS the shard,
   *  and deletes only the rows the re-read proves are in it — never on a
   *  write's return code. DISARMED unless `EDGAR_EVICT_APPLY=true`.
   *  Handler: services/us-fundamentals app/jobs/evict.py */
  EDGAR_EVICT: "edgar-evict",
} as const;

/**
 * Returns the Pub/Sub environment suffix: "qa", "prod", or "local".
 *
 * - PUBSUB_ENV=local       → use *-local topics (isolated dev environment)
 * - PUBSUB_ENV=qa          → use *-qa topics (QA shared infra)
 * - PUBSUB_ENV=prod        → use *-prod topics (production)
 * - NODE_ENV=production    → fallback to "prod"
 * - everything else        → fallback to "qa"
 *
 * The "local" mode is what isolates a developer's machine from QA Pub/Sub
 * fan-out. Without it, every QA-published message (e.g. Cloud Scheduler
 * triggering mf-sync) is delivered to BOTH QA Cloud Run workers AND any
 * local dev worker that has a pull subscription on the same topic, causing
 * duplicate concurrent runs and write conflicts on shared collections.
 * Set PUBSUB_ENV=local in your local .env to opt into the isolated topics.
 */
export function getPubSubEnv(): "qa" | "prod" | "local" {
  const explicit = process.env.PUBSUB_ENV;
  if (explicit === "prod" || explicit === "qa" || explicit === "local") {
    return explicit;
  }
  return process.env.NODE_ENV === "production" ? "prod" : "qa";
}

/**
 * Returns the environment-suffixed topic name.
 * e.g. getTopicName("instrument-sync") → "instrument-sync-qa"
 *      (or "instrument-sync-local" when PUBSUB_ENV=local)
 */
export function getTopicName(baseTopic: string): string {
  return `${baseTopic}-${getPubSubEnv()}`;
}

// ============================================
// MONEY-841 — broker-sync shard config
// ============================================
// Lives in @usemoney/types/pubsub because BOTH the web app (sets the bucket on
// connect / backfill) and the worker (fans the cron out + filters per bucket)
// import it; a single source keeps the hash identical on both sides, which is
// what guarantees a connection always lands in the same shard.

/** Default shard count. 64 buckets ≈ ≤30 connections/shard at ~2k connections. */
export const DEFAULT_SYNC_BUCKET_COUNT = 64;

/**
 * The active shard count. Env-overridable via `SYNC_BUCKET_COUNT`; a missing,
 * non-numeric, zero, or negative value falls back to {@link DEFAULT_SYNC_BUCKET_COUNT}.
 * Read as a function (not a frozen constant) so a test / ops run can set the env
 * before first use; callers should treat the result as stable within a process.
 */
export function getSyncBucketCount(): number {
  const n = Number(process.env.SYNC_BUCKET_COUNT);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SYNC_BUCKET_COUNT;
}

/**
 * Deterministically map a userId → a shard in `[0, count)`.
 *
 * Uses a 32-bit FNV-1a hash so the distribution is stable and even — the SAME
 * userId ALWAYS yields the SAME bucket (never `Math.random`, or a re-bucketed
 * connection would be missed by the cron and silently stop syncing). All of a
 * user's broker connections share one bucket (sharding is per USER, not per
 * connection), so a user's whole portfolio syncs together in one shard message.
 *
 * `count` defaults to {@link getSyncBucketCount}; pass it explicitly in a hot
 * loop (e.g. the backfill script) to avoid re-reading the env each call.
 */
export function syncBucketFor(
  userId: string,
  count: number = getSyncBucketCount(),
): number {
  // FNV-1a 32-bit. `Math.imul` keeps the multiply in 32-bit space; `>>> 0`
  // coerces to an unsigned int so the final modulo is always non-negative.
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return (hash >>> 0) % count;
}

// Job data interfaces (shared between web app publisher and worker consumer)
export interface PairingJobMessage {
  jobId: string;
  userId: string;
  batchId?: string;
}

export interface ImportJobMessage {
  jobId: string;
  userId: string;
  content?: string; // Inline CSV content (small files, <10MB)
  fileUrl?: string; // GCS URL (large files)
  brokerFormat: string;
  fileType: "csv" | "xlsx";
  fileName?: string;
  brokerConnectionId?: string;
  linkToManual?: boolean;
}

export interface SyncJobMessage {
  jobId: string;
  userId: string;
  brokerConnectionId?: string;
  broker?: string;
  dataTypes?: ("holdings" | "positions" | "trades" | "mutualFunds")[];
  /** Set to true only for Cloud Scheduler-triggered bulk syncs that use userId="*" */
  isScheduled?: boolean;
  /**
   * MONEY-841 (scaling foundation): the shard this scheduled sync covers. The
   * daily cron publishes ONE wildcard fan-out message (isScheduled:true, NO
   * syncBucket) → the worker FANS OUT into {@link SYNC_BUCKET_COUNT} per-bucket
   * messages, each carrying a `syncBucket`. A message WITH `syncBucket` syncs
   * ONLY that bucket's connections (`where.syncBucket = N`), so 580+ free-user
   * connections process in parallel shards instead of one worker serial-looping
   * every connection (the ~1-2k scaling cliff). Omitted on per-user / connect /
   * manual-Sync jobs (those carry a concrete userId).
   */
  syncBucket?: number;
  /**
   * MONEY-837: when set, the worker ALSO backfills the historical tradebook for
   * the last N days (Zerodha Console/backoffice API). Connect-time job = full
   * backfill (~730); weekly catch-up = ~30. Omit on the day's-data syncs
   * (market-hours / EOD) so they stay fast.
   */
  historicalDays?: number;
  /**
   * MONEY-839: when true (set ONLY on the connect-time backfill, not the weekly
   * cron), the worker emails the user a "historical import complete" summary
   * once the backfill finishes — fulfilling the connect email's "we'll email you
   * when it's done" promise.
   */
  historicalEmail?: boolean;
  /**
   * MONEY-848: when true, the worker sends a "Sync Complete" summary email
   * (SyncCompleteEmail) on a SUCCESSFUL day-data sync, with per-type counts from
   * `result.perConnection`, gated under the "sync-complete" email preference.
   *
   * Set ONLY by the brokers-page manual Sync button (a deliberate, user-initiated
   * sync where a confirmation is expected). It is intentionally OMITTED by the
   * silent refresh paths — holdings/positions per-tab refresh and the tradebook
   * "Resync" (syncAllBrokersAction) — and by the scheduled bulk cron, so routine
   * background syncs never email. Independent of `historicalEmail` (that one
   * covers the slow connect-time backfill).
   */
  syncEmail?: boolean;
}

// Market data job messages (system-level, no userId required)
export interface InstrumentSyncMessage {
  exchanges?: string[]; // Optional filter, default: all supported
  forceFullSync?: boolean; // Re-sync even if synced today
}

/**
 * Sources permitted for a SHARED-table market-data sync job. These jobs write to
 * cross-user caches (DailyPrice / IntradayBar) which, per the Zerodha market-data
 * commitment (MONEY-566), may only ever hold PUBLIC data — a broker source
 * (ZERODHA) must never be requested here. The IntradayBar writer additionally
 * enforces this at runtime via `assertPublicPriceSource()` in `@usemoney/core`.
 * Extend as new FREE providers are added (e.g. "STOOQ"); never add a broker.
 */
export type PublicPriceSource = "YAHOO";

export interface PriceSyncMessage {
  instrumentIds?: string[]; // Optional subset, default: all active
  dateRange?: { start: string; end: string };
  source?: PublicPriceSource;
  /**
   * If true, the worker computes a rolling dateRange of the last
   * `incrementalDays` days (default: 30) and runs a historical backfill.
   * Used by the daily `price-backfill-incremental-daily` scheduler so the
   * web app can serve charts from the DB cache without a live Yahoo fetch.
   *
   * If both `incremental` and `dateRange` are set, `dateRange` wins.
   */
  incremental?: boolean;
  /**
   * Number of days to backfill when `incremental` is true. Defaults to 30.
   * Overlaps with existing data are safely deduped by upsertDailyPrices.
   */
  incrementalDays?: number;
}

/**
 * Intraday OHLCV sync message - MONEY-123 Part A.
 *
 * System-level job (no userId). Ingests sub-daily bars into the
 * IntradayBar collection so the TradingView UDF history endpoint can
 * serve backward-scroll beyond what live upstream APIs allow (~3
 * trading days from Zerodha/Yahoo per-response cap).
 *
 * Typical daily post-market run (triggered by Cloud Scheduler at
 * 16:05 IST Mon-Fri):
 *
 *   { intervals: ["5m", "15m", "60m"], lookbackDays: 5 }
 *
 * The 5-day lookback is a safety overlap so we re-fetch the last week
 * of bars - in case a previous run hit a transient upstream error or
 * the exchange published corrections.
 */
export interface IntradaySyncMessage {
  /**
   * Optional subset of InstrumentMapping IDs. Defaults to the
   * "top-N tracked" set: all holdings + watchlist + paper-trading
   * positions, deduplicated. Worker is responsible for resolving the
   * default set.
   */
  instrumentIds?: string[];
  /**
   * Optional subset of intervals to ingest. Defaults to
   * ["5m", "15m", "60m"] - 1m is excluded by default because it's
   * ~5x the volume of 5m and most users view 5m or higher.
   */
  intervals?: ("1m" | "5m" | "15m" | "30m" | "60m")[];
  /**
   * Explicit date range. When set, `lookbackDays` is ignored.
   * Start/end are ISO strings (UTC).
   */
  dateRange?: { start: string; end: string };
  /**
   * Number of calendar days to look back from "now". Defaults to 5.
   * The scheduler uses 5 for daily runs; a manual one-off backfill
   * might pass 90 to populate the full rolling window.
   */
  lookbackDays?: number;
  /**
   * Public upstream source for the shared IntradayBar cache. The offline worker
   * runs without user credentials and fetches from Yahoo; a broker source is not
   * permitted here (MONEY-566 — shared caches are Yahoo-only). See
   * PublicPriceSource.
   */
  source?: PublicPriceSource;
  /**
   * If true, re-fetch bars that already exist in the DB for the
   * requested window. Defaults to false - existing bars are skipped
   * by the bulk upsert to keep the daily run fast.
   */
  forceRefresh?: boolean;
}

// Sector enrichment job message (system-level, no userId required)
export interface SectorEnrichmentMessage {
  batchSize?: number; // Max instruments per run (default: 100)
  exchanges?: string[]; // Optional filter, default: ["NSE"]
  forceReEnrich?: boolean; // Re-enrich even if sector is already set
  delayMs?: number; // Delay between Yahoo calls (default: 2000)
}

// AMFI Mutual Fund sync message (system-level, no userId required)
export interface MfSyncMessage {
  /** Force re-sync even if synced today */
  forceFullSync?: boolean;
}

// MF NAV propagation message (system-level, no userId required) — MONEY-1074.
// Copies fresh MutualFundMaster NAVs into user MutualFund rows so MF value/return
// on the dashboard reflect current NAV.
export interface MfNavPropagateMessage {
  /** Rows per keyset page (default 500). */
  batchSize?: number;
}

/**
 * MF NAV-history backfill message (system-level, no userId) — MONEY-1205.
 *
 * Two modes, and they are mutually exclusive in practice:
 *  - `schemeCodes` — an explicit list. What a cold read publishes (one code).
 *  - `universe: true` — the nightly sweep. The worker selects schemes that have
 *    NO stored NAV history, most-valuable-first (`aum desc`), capped at
 *    `batchSize`. This is the publisher that actually covers the platform:
 *    measured 2026-08-18, `mf_nav_history` held 22,446 rows across **16 of
 *    14,223** schemes, so first-click backfill was never going to get there.
 */
export interface MfNavBackfillMessage {
  /** Explicit schemes to backfill. Ignored when empty. */
  schemeCodes?: string[];
  /** Sweep schemes with no stored history (nightly Cloud Scheduler run). */
  universe?: boolean;
  /** Max schemes per run. Default 200 — see the ack-deadline note in the worker. */
  batchSize?: number;
  /** Delay between MFAPI.in calls, ms. Default 250. */
  delayMs?: number;
  /** Re-fetch even for schemes that already have history. */
  force?: boolean;
  /** Free-text provenance for the logs ("cold-read", "scheduler", ...). */
  reason?: string;
}

// Peers sync message (system-level, no userId required) — MONEY-1145.
// Derives `stock_peers` from our OWN instrument + ratio + quote data. Reads no
// upstream, so it runs on BOTH envs and is deliberately NOT in PROD_ONLY_JOBS.
export interface PeersSyncMessage {
  /** Reserved for a future partial run; the job is currently whole-universe. */
  exchanges?: string[];
}

// MF metadata enrichment message (system-level, no userId required)
export interface MfMetadataSyncMessage {
  /** Max funds to process per run (default: 500) */
  batchSize?: number;
  /**
   * Delay between per-fund calls in ms (default: 1000).
   *
   * MONEY-1409 — it no longer protects an upstream from anything. The AMFI
   * provider fetches three whole-universe files ONCE and memoises them at
   * module scope, so this sleeps between DB writes. It is ~82% of
   * `mf-metadata-sync`'s 600s ack deadline at batchSize 500 and is the first
   * lever to pull if that job needs to drain faster.
   */
  delayMs?: number;
  /** Re-enrich all funds, even if recently synced */
  forceReEnrich?: boolean;
}

/**
 * MONEY-240 A - research preview-plan worker fallback.
 *
 * Fired when /api/research/preview-plan can't return inline within
 * the 4 s soft-timeout (LLM rewrite contention / cold-start). The
 * worker re-runs the rewrite at its own pace and writes the result
 * to Redis under `research:preview-plan:job:{jobId}`. The browser
 * polls /api/research/preview-plan/[jobId]/status until it's there.
 */
export interface ResearchPreviewPlanJobMessage {
  jobId: string;
  /**
   * Owner of this preview-plan job. MONEY-595 (A01): the worker writes the
   * result under a USER-NAMESPACED Redis key
   * (`research:preview-plan:job:{userId}:{jobId}`) and the status endpoint
   * only reads its caller's namespace, so a guessed/leaked jobId can never
   * surface another user's rewritten brief.
   */
  userId: string;
  query: string;
  symbols?: string[];
  preset?: string;
  customSkills?: string[];
  extraSkills?: string[];
  removedSkills?: string[];
  model?: string;
  /**
   * The deterministic-only response the route already returned to the
   * browser (estimates, skills, etc.). Worker overlays the
   * LLM-rewritten query on top so it can write a complete cached
   * response in one shot.
   */
  deterministic: Record<string, unknown>;
}

export interface ResearchJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  query: string;
  skill?: string;
  symbols?: string[];
  mode?: "fast" | "advanced";
  /** v2 (MONEY-219) - extras for the planner + worker. */
  customSkills?: string[];
  researchFocus?: string;
  /** Preset id (`quick-pulse` | `investment-thesis` | …). */
  preset?: string;
  /** Model override; planner/worker default to RESEARCH_DEFAULT_MODEL when omitted. */
  model?: string;
  /**
   * MONEY-396 (Document Vault) — user-uploaded document ids pinned to this
   * research run. The agent retrieves the embedded chunks of these docs
   * (strictly scoped to this `userId`) and stamps the evidence onto the
   * synthesis task so the report can cite the user's own documents. Treated as
   * UNTRUSTED data downstream (fenced, never executed). Unset → unchanged run.
   */
  pinnedUserDocumentIds?: string[];
  /**
   * MONEY-794 (C1c) — institutional run-parameters. All optional; unset →
   * identical plan/report. The agent stamps these onto task params and feeds
   * horizon + reportLength into the synthesizer prompt.
   *   - horizon: stamped onto every `fetch_price_history.period`.
   *   - benchmark: mapped to an index symbol (NIFTY50→^NSEI, …) stamped onto
   *     the benchmark fetch + beta task params.
   *   - assumptions: stamped onto compute_dcf / compute_wacc /
   *     compute_scenario_analysis params (wacc / terminalGrowth / growthOverride).
   *   - reportLength: synthesizer section-depth guidance (brief/standard/full).
   *   - varConfig: stamped onto compute_var / compute_position_var params.
   */
  horizon?: "1y" | "3y" | "5y";
  benchmark?: string;
  assumptions?: {
    wacc?: number;
    terminalGrowth?: number;
    growthOverride?: number;
  };
  reportLength?: "brief" | "standard" | "full";
  varConfig?: {
    confidence?: 95 | 99;
    horizonDays?: 1 | 10;
  };
}

// Portfolio roast job message
export interface RoastJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  mode: "overall" | "broker";
  broker?: string;
  /** MONEY-837: scope to a specific account when a broker has multiple logins. */
  brokerUserId?: string;
  assetType: "stocks" | "mf" | "all";
  /**
   * MONEY-145 - narrative bias for the worker prompt.
   *   - "PORTFOLIO" (default): emphasises allocation, concentration,
   *     sector mix, stock quality.
   *   - "TRADEBOOK": emphasises entry/exit timing, churn, realised P&L
   *     vs hold, behaviour gap.
   */
  scope?: "PORTFOLIO" | "TRADEBOOK";
  /** MONEY-837: tradebook-subset scope — ISO date bounds + symbol filter. */
  dateFrom?: string;
  dateTo?: string;
  symbols?: string[];
}

/**
 * MONEY-553 — deep comparison job message.
 *
 * Published by `startComparisonAction`; consumed by the comparison worker
 * processor. `kind` selects the skill (`mf` → mf-comparison, `stock` →
 * multi-comparison); `depth` drives the credit cost and the skill's
 * lean-vs-full enrichment. SEBI-safe: the skills emit observations / scores /
 * flags only, never a winner.
 */
export interface ComparisonJobMessage {
  jobId: string;
  userId: string;
  sessionId: string; // ComparisonSession.sessionId
  kind: "stock" | "mf";
  /** "deep" | "comprehensive" | "advanced" | "custom" */
  depth: string;
  symbols: string[];
  /** Optional exchange hint forwarded to the skill (stock comparisons). */
  exchange?: string;
  /**
   * MONEY-619 (Phase 3) - tier-resolved research model id. Set by
   * `startComparisonAction` via `resolveResearchModel(planId, composerPick)`
   * and forwarded into `agent.run({ model })` so a paid comparison runs on
   * the tier's Pro model (gemini-3.1-pro-preview) rather than the
   * hard-coded advanced default. Omitted / unknown ids fall back
   * to the advanced config inside the agent's tools.
   */
  model?: string;
}

// Document processing job message
export interface DocumentProcessMessage {
  jobId: string;
  userId: string;
  documentId: string;
  action: "extract_text" | "generate_report" | "fetch_url" | "fetch_nse";
  url?: string; // For fetch_url action
  reportType?: "tax" | "risk" | "portfolio_statement"; // For generate_report action
  reportParams?: Record<string, unknown>; // Extra params for report generation (fy, etc.)
}

// Newsletter publish job message (system-level, no userId required)
export interface NewsletterPublishMessage {
  postId?: string; // Optional: specific post. If omitted, checks all due SCHEDULED newsletters.
}

// L3 Comprehensive Analysis job message
export interface L3AnalysisMessage {
  jobId: string;
  userId: string;
  sessionId: string; // AnalysisSession.sessionId
  reservationId?: string; // Legacy - unified credits don't use reservations
  segmentIndex: number; // 0-based, which segment to run
  /**
   * MONEY-619 (Phase 3) - tier-resolved research model id. Persisted on the
   * AnalysisSession by `startComprehensiveAnalysisAction`; the worker reads
   * `session.model` so every segment (and the executive synthesis) runs on
   * the tier's Pro model. Also carried forward on the chain message as a
   * fast-path hint. Omitted / unknown / env-gated ids fall back to the
   * advanced config inside the agent + `getResearchModel`.
   */
  model?: string;
}

// Login briefing job message
export interface LoginBriefingMessage {
  userId: string;
  briefingId: string;
}

// Strategy scan job message
export interface StrategyScanMessage {
  jobId: string;
  userId: string;
  scanId: string;
  strategyId: string;
  isBuiltIn: boolean;
  filters: unknown[];
  logic: string;
  scanType: string;
  limit: number;
}

// Stock document sync message (system-level)
export interface StockDocumentSyncMessage {
  /** Specific symbols to sync (empty = all tracked stocks) */
  symbols?: string[];
  /** Ignore staleness, re-fetch everything */
  forceRefresh?: boolean;
  /** Only sync specific doc types */
  docTypes?: string[];
  /**
   * Restrict the run to these SOURCE LEGS — MONEY-1259.
   *
   * `docTypes` cannot express this. `annual_report` and `credit_rating` belong
   * to BOTH `NSE_ANNOUNCEMENT_DOC_TYPES` and `SCREENER_PAGE_DOC_TYPES`, so
   * asking for annual reports necessarily switches the per-symbol NSE
   * announcements fan-out on as well — doubling load that
   * `annual-reports-sync-daily` already carries.
   *
   * INTERSECTS with the legs `docTypes` implies and can only ever REMOVE one,
   * never add: the same contract `resolveLegsForTarget` holds for the BSE-only
   * partition. Omitted means "whatever docTypes implies", which is every
   * caller that existed before this field.
   */
  sources?: Array<"nse" | "screener" | "tickertape">;
  /**
   * PAGE SIZE — instrument rows pulled per run, clamped to
   * `MAX_SYMBOLS_PER_RUN` (250).
   *
   * A page size and a runaway guard, NOT the throughput control — the run's
   * wall-clock budget (`SYNC_RUN_TIME_BUDGET_MS`) is. MONEY-1255.
   */
  batchSize?: number;
  /**
   * MONEY-1255 — self-chain depth. Absent/0 on a scheduler trigger; each
   * chained follow-up carries the previous depth + 1, and the chain refuses
   * once the next depth would reach `MAX_SYNC_CHAIN_DEPTH`. That bound never
   * consults the database, so it is the termination proof.
   */
  chainDepth?: number;
}

/**
 * MONEY-783 - stock document extraction message (system-level, no userId).
 *
 * Drives Document AI (layout-aware OCR, ~30pp online cap) / pdf-parse text
 * extraction over PENDING PDF `StockDocument` rows, flips them to READY with
 * `textContent`, and chains a STOCK_DOCUMENT_EMBED job. No-ops when there are no
 * PENDING PDFs. The worker works before the Document AI processor is
 * provisioned (falls straight back to pdf-parse).
 */
export interface StockDocumentExtractMessage {
  /** Specific symbols to extract (empty = all PENDING PDFs) */
  symbols?: string[];
  /** Only extract specific doc types */
  docTypes?: string[];
  /** Also re-run FAILED docs (default: only PENDING). Never self-chains. */
  force?: boolean;
  /**
   * Max documents to pull per run (default: DEFAULT_EXTRACT_BATCH_SIZE, 500).
   *
   * A PAGE SIZE and a runaway guard, NOT the throughput control — the run's
   * wall-clock budget is. MONEY-1255.
   */
  batchSize?: number;
  /**
   * MONEY-1255 — self-chain depth. Absent/0 on a scheduler trigger; each
   * chained follow-up carries the previous depth + 1.
   *
   * THIS FIELD IS THE TERMINATION PROOF. The processor refuses to publish once
   * the next depth would reach `MAX_CHAIN_DEPTH`, so a chain is at most that
   * many messages long whatever the queue is doing. Every other stop condition
   * (queue drained, nothing left PENDING, `force`) can only end it sooner.
   *
   * It is sanitised on arrival (`normalizeChainDepth`): a missing, negative,
   * fractional or non-numeric value reads as 0, and anything above the ceiling
   * is clamped TO the ceiling, so a forged value ends the chain rather than
   * extending it.
   */
  chainDepth?: number;
}

/**
 * MONEY-840/844 — corporate-actions sync message (system-level, no userId).
 *
 * The worker resolves a target symbol set (held + active equities, or the
 * explicit `symbols` override), fetches Screener + NSE corporate actions,
 * normalizes + merges them, upserts the history-preserving `CorporateAction`
 * table, and archives a per-symbol JSON snapshot to GCS. Cron: weekly.
 */
export interface CorporateActionsSyncMessage {
  /** Specific symbols to sync (bare NSE symbols, e.g. "RELIANCE"). Empty/omitted
   *  = the held + active-equity universe resolved by the worker. */
  symbols?: string[];
  /** Max symbols to process per run (default: 200). NSE is rate-limited, so the
   *  worker also paces per-symbol like the other NSE jobs. */
  maxSymbols?: number;
  /** Re-archive the GCS snapshot even when no rows changed. The DB upsert is
   *  always idempotent regardless of this flag. */
  forceRefresh?: boolean;
}

// MONEY-851: free EOD price seed from BSE/NSE bhavcopy (system-level)
export interface BhavcopySyncMessage {
  /** YYYY-MM-DD trading day to ingest. Omitted = the most recent trading day. */
  date?: string;
  /** Exchanges to fetch (default: both BSE + NSE). */
  exchanges?: ("BSE" | "NSE")[];
  /** Also pull the NSE all-indices close file. */
  includeIndices?: boolean;
  /** Backfill window (YYYY-MM-DD): ingest each trading day, off-hours + paced. */
  backfillFrom?: string;
  backfillTo?: string;
}

// MONEY-1097 (Data Engine P2): archive-first capture of the NSE/BSE report set
export interface ReportArchiveSyncMessage {
  /** YYYY-MM-DD trading day. Omitted = the most recent trading day. */
  date?: string;
  /**
   * Which cadence bucket to run. "daily" is the two nightly crons; "monthly"
   * is the 3rd-of-month run; "all" is a manual catch-up.
   *
   * "none" archives NOTHING and exists for the weekly drift-guard run: that
   * job fires on a Saturday, when no family publishes anything, so without it
   * the guard would have to manufacture a full set of 404s just to reach the
   * one thing it came to do.
   */
  cadence?: "daily" | "weekly" | "monthly" | "all" | "none";
  /**
   * Poll NSE's daily-reports index and warn about fileKeys that appeared since
   * the last check. Set on ONE run per week — it costs ~12 extra API calls and
   * the answer does not change hourly.
   */
  driftGuard?: boolean;
  /**
   * Re-fetch these specific families, bypassing the "already archived today"
   * skip. An operator override for a one-off repair; without the bypass,
   * asking to re-fetch a family the evening run already got would silently
   * do nothing.
   */
  familyIds?: string[];
}

/**
 * MONEY-1106 (Data Engine P8b) — official macro series sync (system-level).
 *
 * The worker walks `MACRO_SOURCES` (@usemoney/core/market-data/macro-series),
 * pulls each page's bytes through `getFeedAsset` into `feeds/RBI/`, parses the
 * HTML table and upserts `MacroSeries` on (seriesId, period).
 *
 * Every field is an operator override; the crons publish `{}`.
 */
export interface MacroSyncMessage {
  /**
   * Restrict the run to these source ids ("rbi-nsdp-forex"). Omitted/empty =
   * every source.
   *
   * An id matching nothing yields an EMPTY run, deliberately — it does not fall
   * back to "all". A typo that silently widened the run to the whole registry
   * is the opposite of what an operator asking for one page wants.
   */
  sourceIds?: string[];
}

// MONEY-852: BSE corporate announcements bulk ingest (all stocks, system-level)
export interface BseAnnouncementsSyncMessage {
  /** Date window (YYYY-MM-DD; the worker formats for the BSE API). Omitted = recent. */
  fromDate?: string;
  toDate?: string;
  /** Max pages to paginate per run (BSE announcements are paginated). */
  maxPages?: number;
}

// Stock document embedding message (system-level)
export interface StockDocumentEmbedMessage {
  /** Specific symbols to embed (empty = all unembedded) */
  symbols?: string[];
  /** Re-embed even if already embedded */
  forceReindex?: boolean;
  /** Max documents to process per run (default: 200) */
  batchSize?: number;
  /** Only embed specific doc types */
  docTypes?: string[];
}

// Resend contact sync message (system-level)
export interface ResendContactSyncMessage {
  /** Force re-sync all users (default: false - only syncs users not in Resend) */
  forceResync?: boolean;
}

/**
 * NSE index constituent sync (MONEY-301; archive-first since MONEY-1100
 * P4.3).
 *
 * System-level job (no userId). Refreshes the `IndexConstituent` table
 * with the latest NSE-published members for each tracked broad-market
 * index. Cloud Scheduler runs Sunday 03:00 IST so weekly index
 * rebalances are picked up before Monday open.
 *
 * Source ladder per index id: the archived `ind_*list.csv` copy (real
 * membership, 8 indices), then the static emergency arrays, then the
 * mcap-rank derivation — see the processor header for why each rung
 * survives.
 *
 * If the `indexes` field is omitted the worker syncs every index in
 * the canonical list (see `index-constituent-sync.ts`).
 */
export interface IndexConstituentSyncMessage {
  /** Subset of index ids to sync (e.g. ["nifty50", "banknifty"]).
   *  Default: every supported index. */
  indexes?: string[];
  /** Re-write members even when the index hasn't changed since the
   *  last sync - used after schema edits or constituent-mapper bumps. */
  forceRefresh?: boolean;
}

/**
 * Sparkline pre-compute sync message (system-level, no userId).
 *
 * Pre-computes close-price arrays for the "hot" symbol universe so list
 * views (watchlist, markets overview, discover, screener) can render
 * sparklines from Redis rather than hitting Yahoo per-symbol per-request.
 *
 * The universe defaults to: all indices + top 500 instruments by volume
 * + every symbol referenced by any watchlist or research list.
 */
export interface SparklineSyncMessage {
  /** Optional subset of symbols. Default: full hot universe. */
  symbols?: Array<{ symbol: string; exchange: "NSE" | "BSE" }>;
  /** Optional subset of windows. Default: ["1D", "1W"]. */
  windows?: ("1D" | "1W" | "1M")[];
  /** Re-fetch even if fresh cache entry exists. */
  forceRefresh?: boolean;
}

// MONEY-408 - news RSS sync job message
export interface NewsRssSyncMessage {
  /** Optional source filter - when omitted, all configured feeds are fetched. */
  sources?: string[];
  /** Soft per-feed item cap (default 50) */
  maxPerFeed?: number;
}

// MONEY-408 - alert evaluator job message
export interface AlertEvaluatorMessage {
  /** Optional user scope. When omitted, processes all ACTIVE alerts. */
  userId?: string;
  /** Skip cooldown check (admin override / replay). Default false. */
  force?: boolean;
}

// MONEY-406 - strategy stats sync job message
export interface StrategyStatsSyncMessage {
  /** Optional subset of strategy ids; default all built-ins. */
  strategyIds?: string[];
  /** Force recompute even if cached stats are fresh. */
  force?: boolean;
}

/**
 * MONEY-391 — async account deletion.
 *
 * Server action does only the security-critical sync work:
 *   1. Verify OTP
 *   2. Capture audit snapshot
 *   3. Write DeletedUserAudit row (status=PENDING)
 *   4. Publish this message
 *   5. Return success → client signs out + redirects to homepage
 *
 * Worker processor then:
 *   1. Cancel Dodo subscription (best-effort, captured in audit)
 *   2. Hard-delete user DB rows (cascades via Prisma)
 *   3. Delete Clerk user
 *   4. Send confirmation email
 *   5. Flip audit row status to COMPLETED (or FAILED + deletionError)
 */
/**
 * MONEY-445: payload that drives the entire delete-account pipeline.
 * The server action publishes this and returns immediately — the worker
 * handles audit-row creation, Clerk delete, snapshot, Dodo cancel, email,
 * and User row delete (in that order). No `auditId` here: the worker
 * creates the audit row as its first step, idempotently. No
 * `dodoSubscriptionId` either: the worker reads it from the User's
 * Subscription record during snapshot.
 */
export interface AccountDeletionMessage {
  /** Internal user id to hard-delete. */
  userId: string;
  /** Clerk user id to delete first (kills the session). Null for legacy users. */
  clerkId: string | null;
  /** Email used to seed the audit row + send the confirmation. */
  email: string;
  /** Best-effort display name; worker also writes the snapshot name. */
  name: string | null;
  /** Who initiated the deletion. */
  deletedBy: "user" | "admin" | "system";
  /** Optional user-supplied reason; surfaces in admin tooling. */
  reason?: string;
  /** Request IP for forensics. */
  ipAddress?: string;
  /** Request user-agent for forensics. */
  userAgent?: string;
  /** Internal id of the admin who triggered the deletion (when deletedBy = "admin"). */
  adminUserId?: string;
}

/**
 * MONEY-144 — hourly Clerk-delete sweep.
 *
 * Cron triggers this with an empty / bounded payload. Worker queries
 * `DeletedUserAudit` for rows where `status === "LOCKED"` and
 * `clerkDeleteScheduledFor <= now`, then calls `Clerk.users.deleteUser`
 * for each one, releasing the email back into Clerk's signup pool.
 *
 * Bounded `batchSize` keeps each run inside the Cloud Run request
 * window even on a backlog day.
 */
export interface ClerkDeleteSweepMessage {
  /** Max audit rows to process per run. Default 100. */
  batchSize?: number;
  /** Override "now" for replay / tests; ISO string. */
  now?: string;
}

/**
 * MONEY-789 (B4) — nightly investor self-learning rollup.
 *
 * Cron triggers this with an empty / bounded payload. The worker discovers
 * active users (UserEvent ∪ Trade ∪ Holding in `activeWindowDays`), then per
 * user derives a `PortfolioBehaviorSnapshot`, drifts their `InvestorProfile`,
 * decays `ConceptMastery` idle longer than `decayAfterDays`, rebuilds
 * `PortfolioInsight` rows, and reprojects FIRE. Best-effort per user; the
 * route ACKs 200 even on a throw.
 */
export interface InvestorRollupMessage {
  /** Override "now" for replay / tests; ISO string. Defaults to the run time. */
  now?: string;
  /** Lookback (days) for treating a user as "active". Default 14. */
  activeWindowDays?: number;
  /** Idle-days threshold after which concept mastery starts to fade. Default 60. */
  decayAfterDays?: number;
}

/**
 * MONEY-980 — the nightly Tiingo US EOD sync (system-level, no userId).
 *
 * The scheduler payload is deliberately `{}`. Every field below is an OVERRIDE
 * for a manual/targeted run; the defaults live on the processor's constants
 * (`us-eod-sync-logic.ts`), because a number pinned in `setup-scheduler.sh` and
 * a constant in the worker are two spellings of one fact and that file has no
 * way to fail when they drift (MONEY-1255).
 *
 * EVERY field is read and NARROWED explicitly in `routes/us-eod-sync.ts`. A
 * field declared here and forwarded by nobody is silently inert — that is the
 * MONEY-1235 `createMissing` defect, where an opt-in flag existed on the type,
 * was documented as supported, and could not be opted into in production.
 */
export interface UsEodSyncMessage {
  /**
   * Restrict the run to these US tickers (Tiingo spelling: dashes, not periods
   * — `BRK-A`, `SPG-P-J`). Omitted = the whole ACTIVE US population, rotated.
   *
   * A scoped run NEVER self-chains: it is a manual repair with a finite target,
   * so there is no next page to fetch and chaining would re-fetch the same
   * symbols until the depth ceiling.
   */
  symbols?: string[];
  /**
   * EOD page size for leg (a). Default `DEFAULT_US_EOD_BATCH_SIZE`.
   *
   * A PAGE SIZE and a runaway guard, NOT the throughput control — the wall
   * clock and the plan-derived request budget are. Raising a count is the lever
   * MONEY-1201 explicitly rejected: per-symbol cost is a network round trip we
   * do not own, so a count only holds while the network does.
   */
  batchSize?: number;
  /** NAV page size for leg (b). Default `DEFAULT_US_MF_BATCH_SIZE`. */
  mfBatchSize?: number;
  /**
   * Trailing window, in CALENDAR days, fetched per symbol. Default
   * `DEFAULT_LOOKBACK_DAYS` (5), clamped to 1..`MAX_LOOKBACK_DAYS` (30).
   *
   * THE CLAMP IS THE POINT. One Tiingo request returns a symbol's ENTIRE
   * history (AAPL: 11,517 bars / 820 KB in one call), so an unbounded window
   * here would turn a 14,041-symbol night into a multi-GB, multi-hour pull that
   * cannot finish inside the ack deadline. Whole-history pulls belong to the
   * backfill, which has its own checkpoint table for exactly that reason.
   */
  lookbackDays?: number;
  /**
   * Skip leg (d), the USDINR `FxRate` write. For a repair run that only wants
   * price bars; the FX leg is one call and is on by default.
   */
  skipFx?: boolean;
  /**
   * Self-chain depth. Absent/0 on a scheduler trigger; each published follow-up
   * carries the previous depth + 1.
   *
   * THIS FIELD IS THE TERMINATION PROOF. `shouldChainAnotherBatch` refuses once
   * the next depth would REACH `MAX_CHAIN_DEPTH`, so a chain is at most that
   * many messages whatever the database, the clock or the queue are doing.
   * Every other stop condition can only end it sooner. Sanitised on arrival by
   * `normalizeChainDepth`: missing / negative / fractional / non-numeric reads
   * as 0, and an over-large forged value is CLAMPED TO the ceiling, so forging
   * it ends the chain rather than extending it.
   */
  chainDepth?: number;
  /**
   * Epoch ms at which the FIRST link of this chain started. Set by the
   * processor when it publishes link 1, forwarded unchanged thereafter.
   *
   * It exists because this job's rotation marker does not REMOVE a row from the
   * selected set the way `stock-document-extract`'s status flip does — a synced
   * row just moves to the back of an `usEodSyncedAt asc` queue. So a long
   * enough chain wraps and starts re-fetching symbols it synced twenty minutes
   * ago, silently spending a quota we cannot observe. Comparing the page's
   * OLDEST marker against this stamp detects the wrap; an absent or unusable
   * value simply reads as "not wrapped", which can only make the chain run its
   * already-bounded length, never longer.
   */
  chainStartedAt?: number;
}

/**
 * MONEY-1309 — the 24x7 US news poller.
 *
 * The scheduler payload is deliberately `{}`. Every field below is an OVERRIDE
 * for a manual run; the defaults live on the processor's constants and in
 * `tiingo-news-articles-logic.ts`, because a number pinned in
 * `setup-scheduler.sh` and a constant in the worker are two spellings of one
 * fact and that file has no way to fail when they drift (MONEY-1255).
 *
 * EVERY field is read and NARROWED explicitly in `routes/tiingo-news-poll.ts`.
 * A field declared here and forwarded by nobody is silently inert — the
 * MONEY-1235 `createMissing` defect, where an opt-in flag existed on the type,
 * was documented as supported, and could not be opted into in production.
 *
 * ## THE TOPIC CONSTANT AND ITS SCHEDULER ENTRY LANDED TOGETHER — MONEY-1309 T7
 *
 * This block used to say "THIS TYPE HAS NO `PUBSUB_TOPICS` ENTRY YET, AND THAT
 * IS DELIBERATE", and the reasoning was right: `topic-publisher-coverage` fails
 * a declared topic that nothing publishes to, and correctly so — a topic with
 * no publisher is the MONEY-1205 dead-topic shape, created by the infra
 * scripts, consumed by a route, and never fired.
 *
 * Both halves are now in the tree, and the coupling was ENFORCED rather than
 * remembered. Adding the `SCHEDULER_DEFS` row alone turned
 * `topic-publisher-coverage` red from the OTHER direction — "scheduler entries
 * whose TOPIC_BASE is not in PUBSUB_TOPICS: tiingo-news-poll" — so the pair
 * could not be half-landed in either order:
 *
 *   PUBSUB_TOPICS:   TIINGO_NEWS_POLL: "tiingo-news-poll",
 *   SCHEDULER_DEFS:  "tiingo-news-poll|*\/2 * * * *|tiingo-news-poll|{}|…"
 *
 * The route is mounted and reachable by direct POST, which is what the founder
 * step verifies before arming the schedule in production.
 */
export interface TiingoNewsPollMessage {
  /**
   * Overlap subtracted from the stored watermark, in ms. Default
   * `DEFAULT_NEWS_OVERLAP_MS` (30 min).
   *
   * THE CURSOR IS NOT A STRICT BOUNDARY and this is the knob that keeps it
   * that way. `crawlDate` is Tiingo's clock and articles arrive out of order,
   * so a `> lastCrawl` window drops the late ones permanently and silently.
   * `planNewsCursor` refuses a non-finite or negative value and falls back to
   * the default rather than clamping to 0 — zero IS the defect.
   */
  overlapMs?: number;
  /**
   * Page size for `/tiingo/news`. Default and maximum
   * `TIINGO_NEWS_MAX_LIMIT` (5,000, the measured honoured ceiling).
   *
   * A repair lever only. Lowering it does not make the run cheaper — the walk
   * simply pages more — and OMITTING the parameter is not "the default page
   * size", it is Tiingo's server default of 100 rows of a market-wide feed,
   * newest-first, which is the MONEY-1264 F1 truncation defect.
   */
  limit?: number;
}

/**
 * MONEY-980 — candle eviction (system-level, no userId).
 *
 * The scheduler payload is deliberately `{}`. Every field below is an OVERRIDE
 * for a manual/targeted run; the defaults are constants in
 * `candle-evict-logic.ts`, because a number pinned in `setup-scheduler.sh` and
 * a constant in the worker are two spellings of one fact and that file has no
 * way to fail when they drift (MONEY-1255).
 *
 * EVERY field is read and NARROWED explicitly in `routes/candle-evict.ts`. A
 * field declared here and forwarded by nobody is silently inert — that is the
 * MONEY-1235 `createMissing` defect, where an opt-in flag existed on the type,
 * was documented as supported, and could not be opted into in production.
 */
export interface CandleEvictMessage {
  /**
   * NARROWS ONLY. `false` turns the deletes off for one run; it can never turn
   * them on when `CANDLE_EVICT_APPLY` has not armed the environment.
   *
   * The inverse (`msg.apply || env`) would make publish rights on this topic
   * sufficient to start deleting price history. Arming is a deploy, which is a
   * review. Same rule and same reason as `XbrlProjectionMessage.apply`.
   */
  apply?: boolean;
  /**
   * Run ONE rule instead of walking all of them.
   * `LOADED` | `WINDOW` | `WINDOW_INTRADAY`.
   *
   * A scoped run never advances to the next rule when its own page runs
   * short — the chain does exactly what was asked and stops. An UNSCOPED chain
   * advances on a short page AND hands over on a full one once the rule has
   * spent its share of `MAX_CHAIN_DEPTH` (`ruleDepthBandEnd`), so a backlog on
   * the first rule cannot consume every link and leave the rest unrun.
   *
   * MONEY-1373 added `WINDOW_INTRADAY`, and this union is the reason it is
   * worth a comment: `EVICT_RULES` in `candle-evict-logic.ts` is the source of
   * truth, and this type plus the route's narrowing are two more copies of it.
   * A rule added there and missed HERE does not fail loudly — the route drops
   * the unrecognised value, `resolveRuleScope` falls back to `EVICT_RULES[0]`,
   * and the new rule's chain link silently restarts on `LOADED` while the run
   * reports `ok` because `LOADED` deleted rows. That is the MONEY-1211 /
   * MONEY-1255 shape: a job that runs on schedule, exits 0, and never touches
   * the population it was added for.
   */
  rule?: "LOADED" | "WINDOW" | "WINDOW_INTRADAY";
  /**
   * Was the `rule` above chosen by an OPERATOR, or by the chain?
   *
   * The two need different behaviour and are otherwise indistinguishable: a
   * scoped run must never advance to the other rule, while a chained link
   * must — and EVERY chained link carries a `rule`, because the link would not
   * know what to walk without one.
   *
   * Reading the scope off `rule`'s presence therefore made links 1..N all look
   * scoped, and with two rules walked in order that left `WINDOW` unreachable
   * on any night the first `LOADED` page came back full: the chain walked
   * `LOADED` to its depth ceiling and ended, having never archived or evicted a
   * single out-of-window year, while the run reported healthy because `LOADED`
   * deleted rows.
   *
   * Set to `false` by the chain when the run it continues was NOT scoped.
   * Omitted by an operator, so the documented hand-published shape
   * (`{"rule":"WINDOW"}`) still scopes. Absent + no `rule` is an unscoped
   * scheduler trigger.
   */
  ruleScoped?: boolean;
  /**
   * Rows to skip. Carried by the chain; 0 on a scheduler trigger.
   *
   * NOT a cursor. The population SHRINKS as the job works it — a deleted row
   * leaves the set, a KEPT one does not — so the next unseen row sits at
   * exactly `skipRows` plus the rows this run kept that sort BEFORE the first
   * row it never examined. That accumulator is what stops a block of rows the
   * job cannot verify from re-occupying the head of the queue every run and
   * starving everything behind it (MONEY-1211 / MONEY-1255).
   *
   * "BEFORE the first row it never examined" is load-bearing and is not the
   * same as "kept this run". The page is ordered but the run iterates by SHARD
   * GROUP, so a run that stops on its wall-clock budget has examined a
   * NON-PREFIX of the page — and adding every kept row would advance this past
   * rows nobody looked at, stranding them for the rest of the chain.
   * `chainKeptBeforeUnexamined` computes the figure that makes the sentence
   * above true; it errs low, so the next link re-examines rather than skips.
   */
  skipRows?: number;
  /**
   * Rows per page. Default `DEFAULT_EVICT_BATCH_SIZE`.
   *
   * A PAGE SIZE and a runaway guard, NOT the throughput control — the 420s wall
   * clock is. The cost that matters is per SHARD GROUP (a GCS read, plus a
   * read-modify-write on the WINDOW rule), which a row count cannot express.
   */
  batchSize?: number;
  /**
   * Self-chain depth. Absent/0 on a scheduler trigger; each published follow-up
   * carries the previous depth + 1.
   *
   * THIS FIELD IS THE TERMINATION PROOF. `nextEvictStep` refuses once the next
   * depth would REACH `MAX_CHAIN_DEPTH`, so a chain is at most that many
   * messages whatever the database or the clock are doing. Sanitised on arrival
   * by `normalizeChainDepth`: missing / negative / fractional / non-numeric
   * reads as 0, and an over-large forged value is CLAMPED TO the ceiling, so
   * forging it ENDS the chain rather than extending it.
   */
  chainDepth?: number;
  /**
   * LEAF: evict ONE intraday unit, whole sessions only. Set ONLY by the
   * planner. A leaf never chains.
   *
   * MONEY-1373 — ONE TOPIC, TWO MESSAGE SHAPES, the same arrangement
   * `us-filing-insight` uses (MONEY-1324). The daily chain's `WINDOW_INTRADAY`
   * link is a PLANNER: it groups the due rows by `(symbol, timeframe)` and
   * publishes one message carrying this field per unit, back onto this topic.
   *
   * ## Why a unit and not a bigger page
   *
   * `evictOrderBy` is `ts asc` ACROSS ALL SYMBOLS, and 507 symbols emit one M1
   * bar per minute simultaneously — so a 1,000-row page spans ~2 minutes of
   * market time and touches ~500 distinct (symbol, year) shard groups at ~2
   * rows each. Each of those pays a full GCS read-modify-write (~8 MB in, ~8 MB
   * out, plus a verifying read) to delete two rows: ~4-6 s per group, ~80
   * groups inside the 420s budget, ~160-200 rows a link. Against ~712,000 rows
   * a session that is ~200x short, and a bigger `batchSize` does not help
   * because the page is still ts-ordered across symbols.
   *
   * With the unit of work equal to the unit of DELIVERY, the 600s ack deadline
   * bounds ONE shard read-modify-write (~5 s for M1, ~1 s for H1) instead of a
   * page, and Pub/Sub's own concurrency replaces the wall clock, the chain and
   * the depth band entirely.
   *
   * `timeframe` is narrowed to `INTRADAY_TIMEFRAMES` by the route. A leaf naming
   * `D1` is DROPPED rather than run: the D1 population is 20.16M rows over
   * 14,098 symbols and one "unit" of it is a decade of a symbol's history under
   * a rule that was never designed to select it.
   */
  unit?: { symbol: string; timeframe: string };
}

// Pub/Sub push envelope (what Cloud Run receives)
export interface PubSubPushMessage {
  message: {
    data: string; // base64-encoded JSON
    messageId: string;
    publishTime: string;
  };
  subscription: string;
}
