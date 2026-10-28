# UseMoney - Core Product Memory

## What is UseMoney?

UseMoney is an AI-powered trading portfolio management platform for Indian stock
markets. It provides multi-broker integration, portfolio analytics, paper
trading simulation, and FIRE (Financial Independence, Retire Early) planning
tools.

**Website:** https://usemoney.ai

---

## Product Vision

Enable retail investors in India to:

1. Track all their investments across multiple brokers in one place
2. Analyze portfolio performance with AI-powered insights
3. Practice trading strategies without risking real money (Paper Trading)
4. Plan for financial independence with FIRE calculators
5. Learn investing concepts through premium educational content

---

## Tech Stack

| Layer          | Technology                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**   | Next.js 16.2, React 18, TypeScript, Tailwind CSS, shadcn/ui                                                                 |
| **Backend**    | Next.js API Routes, tRPC, Hono (API server)                                                                                 |
| **Database**   | MongoDB Atlas (via Prisma ORM)                                                                                              |
| **Cache**      | Redis (DigitalOcean) with multi-layer caching (Memory + Redis)                                                              |
| **Auth**       | Clerk (authentication & user management)                                                                                    |
| **AI**         | Google Gemini (3.1 Pro + 3 Flash previews; see `packages/core/src/gemini/model-registry.ts`) + Codex router (founder-gated) |
| **Payments**   | Dodo Payments                                                                                                               |
| **Storage**    | Google Cloud Storage (GCS) for learning content                                                                             |
| **Messaging**  | Google Cloud Pub/Sub (job queuing)                                                                                          |
| **Deployment** | Vercel (web), GCP Cloud Run (API & Workers)                                                                                 |
| **Monorepo**   | Turborepo with Yarn workspaces                                                                                              |

---

## Monorepo Structure

```
usemoney-monorepo/
├── apps/
│   ├── web/          # Main Next.js web application
│   ├── api/          # Hono REST + tRPC API for mobile (38 /v1 endpoint families — MOUNTED route() calls, not 41 files)
│   ├── admin/        # Admin dashboard (Next.js)
│   └── content/       # Content management app
├── packages/
│   ├── core/         # Business logic (brokers, pairing, payments)
│   ├── database/     # Prisma schema & client
│   ├── types/        # Shared TypeScript types
│   ├── cache/        # Redis caching utilities
│   ├── security/     # Encryption, rate limiting, cron-auth
│   ├── auth/         # Admin gate + env helpers
│   ├── pubsub/       # Google Cloud Pub/Sub client + job publishers
│   ├── storage/      # GCS storage client
│   ├── trpc/         # tRPC router definitions
│   ├── logger/       # Structured logging
│   ├── validation/   # Zod schemas
│   ├── ui/           # Shared UI components
│   ├── research/      # AI research agent (skills, tools, planner)
│   ├── roast/         # Portfolio roast analysis engine
│   ├── fire/         # FIRE chat engine (parser, tools, executor, server turn) — shared by web + api
│   ├── datadog/       # Datadog APM & metrics
│   ├── content-engine/ # Learning content generation
│   ├── services/     # Shared service-layer logic (admin audit, coupons, entitlements)
│   ├── email/        # Resend email + newsletter templates
│   ├── api-utils/    # Shared API helpers (safeJson, zodParse, cursor pagination)
│   ├── utils/        # Generic utilities + error/advice sanitization, soft-timeout
│   ├── video-studio/ # Video generation (Veo clips, timelines, voiceover)
│   └── ...config/    # ESLint, TypeScript configs
└── workers/          # Background job workers (Cloud Pub/Sub + Hono)
```

---

## Core Features

### 1. Multi-Broker Integration

**Supported Brokers:**

- Zerodha (Kite)
- Upstox
- Angel One (SmartAPI)
- Groww
- Dhan
- Fyers

**Data Synced:**

- Holdings (stocks)
- Positions (F&O)
- Trades (order book)
- Mutual Funds

### 2. Portfolio Analytics

- Dashboard with total portfolio value
- Day change tracking
- Segment-wise breakdown (Equity, F&O, MF)
- P&L analysis

### 3. Trade Book with FIFO Pairing

- Automatic trade pairing (entry/exit matching)
- Row splitting for partial fills
- Support for: SYNCED, IMPORTED, MANUAL trades
- Priority-based duplicate detection

### 4. Paper Trading

- Virtual portfolio with fake money
- Real-time market data (Yahoo Finance)
- P&L tracking without real risk

### 5. FIRE Calculator

- SIP/Lump sum projections
- Retirement corpus planning
- Withdrawal rate calculations

### 6. AI Chat (Premium)

- Portfolio analysis
- Market insights
- Investment recommendations

### 7. Learning Content (Premium)

- Secure video streaming (HLS)
- PDF/Document viewer
- Screen protection & watermarking

### 8. Portfolio Roast (Premium)

- AI-powered portfolio analysis with scoring
- Stock & mutual fund evaluation
- Actionable improvement suggestions

### 9. Risk Analysis (Premium)

- Value at Risk (VaR) calculations
- Drawdown analysis
- Portfolio concentration metrics
- Correlation heatmaps

### 10. Document Management

- PDF/document upload & processing
- Text extraction with AI
- Report generation (tax, risk, portfolio statement)

### 11. Stock Discovery

- Atlas Search-powered instrument search
- Top gainers/losers
- Sector-wise browsing
- Mutual fund discovery with filters

### 12. Notification System

- In-app notifications
- Mark as read/unread
- Bulk clear read notifications

### 13. Demo Mode

- HMAC-signed demo session cookies
- Full app walkthrough without sign-up
- Static demo data for all features

---

## Subscription Tiers

| Tier        | Features                                          |
| ----------- | ------------------------------------------------- |
| **FREE**    | 1 broker, basic analytics, paper trading          |
| **PREMIUM** | Unlimited brokers, AI chat, learning content      |
| **PRO**     | Everything + advanced analytics, priority support |

---

## Key Technical Decisions

### Authentication

- Clerk handles all auth (social login, email, 2FA)
- Clerk userId mapped to internal MongoDB user
- Session tokens for API auth

### Data Security

- Broker credentials encrypted with AES-256-GCM
- Encryption keys per-user stored securely
- Refresh tokens encrypted at rest

### Caching Strategy

- L1: In-memory cache (10s TTL for hot data)
- L2: Redis (5min TTL)
- L3: Stale-while-revalidate for expensive operations

### Trade Pairing Algorithm

- FIFO (First In, First Out) matching
- Groups by: symbol + exchange + broker
- Creates PairedTradeView for efficient querying
- Handles partial fills with row splitting

### Error Handling

- All DB/system errors sanitized before showing to users
- Error patterns mapped to user-friendly messages
- Detailed logs kept server-side

---

## Database Models (Key)

```
User
├── BrokerConnection (1:N)
├── Holding (1:N)
├── Position (1:N)
├── Trade (1:N)
├── PairedTradeView (1:N)
├── MutualFund (1:N)
├── PaperPosition (1:N)
├── FireScenario (1:N)
├── Chat (1:N)
└── Subscription (1:1)
```

---

## Environment Variables

### Required for Web App

```bash
# Database
DATABASE_URL=mongodb+srv://...

# Redis
REDIS_URL=redis://...

# Clerk Auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_...
CLERK_SECRET_KEY=sk_...

# AI
GOOGLE_GENAI_API_KEY=...
ANTHROPIC_API_KEY=...        # MONEY-626 Codex router: enables Codex models in chat + research (worker runtime + eval)
CLAUDE_PORTFOLIO_AGENT=      # set "off" to kill Codex entirely (everyone falls back to Gemini)
CLAUDE_ALLOWED_EMAILS=       # optional CSV allowlist; unset = founder-only (deepshaswat@gmail.com). Gemini is the default for all users.
VERTEX_RAG_ENABLED=          # MONEY-781 retriever seam: unset/"" = Atlas RAG (default, unchanged). "true" + GCP_PROJECT_ID + VERTEX_RAG_CORPUS enables the Vertex RAG retriever (HYBRID — swaps the retrieval layer only; text-gen stays on the configured model). Unrelated to MONGODB_VECTOR_SEARCH_ENABLED (which picks native-Atlas-vs-cosine INSIDE the Atlas retriever).
VERTEX_RAG_CORPUS=           # MONEY-782 P2b: the managed RAG Engine corpus the Vertex retriever queries — a full "projects/{p}/locations/{l}/ragCorpora/{id}" resource name OR a bare id. Provision + obtain it via scripts/ops/setup-vertex-rag.sh. Required (alongside VERTEX_RAG_ENABLED=true + GCP_PROJECT_ID) for the Vertex backend; unset → Atlas.
VERTEX_RAG_LOCATION=         # MONEY-782 P2b: Vertex region for the RAG corpus (default us-central1). Must match the region the corpus was created in.

# Payments
DODO_PAYMENTS_API_KEY=...   # test-mode key on the QA project, live-mode on prod
DODO_WEBHOOK_SECRET=...     # per-endpoint signing secret (test endpoint → QA, live endpoint → prod)
NEXT_PUBLIC_DODO_MODE=test  # "test" on qa.usemoney.ai, "live" on usemoney.ai

# Storage
GCP_PROJECT_ID=...
GCP_STORAGE_BUCKET=...
GCP_SERVICE_ACCOUNT_KEY_BASE64=...

# Document AI (MONEY-783) — layout-aware PDF text extraction in the workers'
# stock-document-extract job. When PROCESSOR_ID is unset the worker falls back
# to pdf-parse, so this is optional / works pre-provisioning.
DOCUMENT_AI_PROCESSOR_ID=...  # Document OCR processor id (GCP Secret Manager: DOCUMENT_AI_PROCESSOR_ID_QA / _PROD)
DOCUMENT_AI_LOCATION=us       # processor region (default: us)

# Company financials + ratios — NSE XBRL (MONEY-1220)
#
# WHERE THE NUMBERS COME FROM, as of Aug 2026: our own archive of NSE's XBRL
# results filings. NOT Tickertape. `api.tickertape.in` answers 200 from a laptop
# and 403 from Cloud Run — it BLOCKED our production egress, which is worse than
# an outage because it is permanent and silent. `financial-data-sync` kept
# firing on schedule, kept returning 200, and wrote zero rows for five months
# while `stock_financials` sat frozen on a March snapshot (32,359 rows, 0
# QUARTERLY). That job is RETIRED; its route survives only to ACK and drop
# messages from a scheduler that has not been torn down yet.
#
# Two nightly jobs replace it, both reading only our own tables:
#   xbrl-projection-daily  23:45 IST      -> StockFinancials (ANNUAL + QUARTERLY)
#   xbrl-ratios-daily      22:00 Mon-Fri  -> StockRatios, after bhavcopy lands
#                                            the close at 21:00
#
# We own 26 of StockRatios' 28 columns (verified against
# `XBRL_OWNED_RATIO_COLUMNS` + `XBRL_UNOWNED_RATIO_COLUMNS`, and pinned by
# `xbrl-ratios-producer.test.ts` so this number cannot drift again — it read
# "23 of 25" for three tickets after `returnBasis`, `ebitdaMargin` and
# `assetTurnover` landed). `targetPrice` and `recommendation` are
# sell-side ANALYST OPINION — in no filing, in no price series, not reproducible
# from primary data — and are deliberately left null rather than scraped. The
# ratios job PARTIAL-updates, so a column a given filing cannot support keeps
# whatever is already there.
#
# screener.in is still used, for DOCUMENTS and corporate actions
# (stock-document-sync, corp-actions enrichment). It is NOT true that it never
# writes StockFinancials — `persistFinancialFallbackInBackground` (called from
# the fetch-income-statement / balance-sheet / cash-flow research tools) writes
# `source: "SCREENER"` at request time. That write clears `mayOverwriteFinancials`
# first, so it can only land in an empty cell or over YAHOO, never over NSE_XBRL
# or TICKERTAPE. Left as-is by MONEY-1220: it is guarded, it is the weakest
# source by declared authority, and the projection displaces it on the next
# nightly run. "Unaffected" rests on PROD evidence — workers stored 49
# announcements, 60+ annual reports and credit ratings in the week of
# 2026-08-19 — NOT on a laptop 200, which is precisely the reading that hid
# Tickertape's block for five months. `API_LIMITS.screener` was cut 2000 -> 500
# after MONEY-853, where a whole-market run hit a per-IP 429 wall and ZERO
# screener data reached GCS while Tickertape's leg landed normally: the same
# silent-partial-failure shape, from a rate limit rather than a block.
#
# What was retired is the API, not the vendor. `stock-document-sync` STILL
# scrapes `www.tickertape.in/stocks/<sid>` — a different host from the 403ing
# `api.tickertape.in`, serving plain HTML — for formatted statement TEXT that
# feeds the research RAG corpus (`stock-document-sync-logic.ts:202`
# TICKERTAPE_BASE; `API_LIMITS.tickertape = 5000` is a per-RUN cap on calls to
# that host, not a delay — the delay is `DELAY_BETWEEN_SYMBOLS_MS = 2000`, which
# is per symbol across all three sources). Whether OUR EGRESS is blocked on the
# www host too has NOT been measured. That job now emits a job-outcome with the
# per-source counts in its reason string, which is what will settle it — and all
# three legs at once — because a non-zero TOTAL document count proves only that
# ONE of its three sources is alive. MONEY-1228 carries the Cloud Run probe. Do
# not read "Tickertape is gone" off this section; read "Tickertape no longer
# supplies financials or ratios".
#
# Known limits, written down rather than discovered later: NSE FILERS ONLY (no
# BSE XBRL ingest exists), history floors at 2018 (pre-2018 index records are
# stubs), and the 3Y/5Y CAGR columns stay null until the backfill has laid down
# 4 and 6 fiscal years respectively.
XBRL_PROJECTION_APPLY=        # "true" ARMS both jobs to write. Ships PRESENT
                              # and "false" in both cloudbuild specs — absent
                              # and "false" must not be the same state, because
                              # "absent" is exactly how MF_METADATA_PROVIDER
                              # disabled its job silently for months
                              # (MONEY-1214). Compared against the literal
                              # string, never Boolean(): Boolean("false") is
                              # true, which would arm the job in the one
                              # configuration meant to keep it off.
                              #
                              # PRECONDITION for flipping it: the F3 reconcile
                              # (scripts/data/xbrl-reconcile.ts) reading READY.
                              # StockFinancials has no `source` in its unique
                              # key, so the FIRST XBRL write for a period
                              # destroys the value it replaced — there is
                              # nothing left to compare against afterwards.
                              # A message may narrow this to false for one run;
                              # it can never arm one.

# Broker APIs (for each broker)
# MONEY-837 — Zerodha two-app model:
#   ZERODHA_API_KEY/SECRET point at the FREE "Personal" Kite app (multi-user
#   access enabled) and power PORTFOLIO SYNC (Profile, Holdings+MF, Positions,
#   Order book, Tradebook) in apps/web + workers. The Personal tier has NO live
#   quotes / charts / WebSockets, so apps/web runtime market data is Yahoo-only.
ZERODHA_API_KEY=...           # Personal (free) app — portfolio sync
ZERODHA_API_SECRET=...        # Personal (free) app — portfolio sync
ZERODHA_SYSTEM_API_KEY=...    # instrument master /instruments dump (public, tier-agnostic)
#   MONEY-1085 — the Kite dump is NOT the whole instrument universe: it omits
#   NSE's SME (Emerge) and book-entry series and carries NO ISIN column, which
#   silently dropped ~766 NSE closing prices per trading day. NSE's own public
#   master CSVs (EQUITY_L.csv + SME_EQUITY_L.csv) are now a second provider
#   alongside Zerodha and supply both. No credentials needed.
#   MONEY-1205 — the Kite dump DOES quote its `name` column (106,262 of 114,427
#   lines; `…,SBIETFQLTY,"SBI NIFTY 200 QUALITY 30 ETF",…`). The parser split it
#   on `line.split(",")`, so 13,287 of 26,669 `InstrumentMapping.name` values
#   (49.8%, incl. 540 of 541 active ETFs) were stored WITH the literal quotes.
#   All three CSV parsers now share one RFC-4180 splitter
#   (`packages/core/src/market-data/csv-line.ts`). NSE rows looked half-healthy
#   only because the EQUITY_L provider's own correct splitter overwrote the
#   names it covers.
#   MONEY-1093 — the Kite dump is also NOT authoritative for `series` or
#   `instrumentType`: it stamps `series` from its own `instrument_type` column
#   ("EQ" for EVERY cash instrument, bonds included) and falls back to
#   instrumentType "EQUITY" for anything it cannot name-match. Because
#   instrument-sync runs 22:00 IST DAILY and bhavcopy-sync 21:00 IST weekdays,
#   it used to overwrite the real exchange series one hour after the price feed
#   wrote it, and revert every deliberate DEBT/REIT retype within 24h — no
#   error, the data just never moved. Providers now declare what they may
#   overwrite on an EXISTING row via `InstrumentProvider.mapToUpdate`; Zerodha
#   omits `series` always and `instrumentType` unless positively identified.
#   BSE's scrip master (api.bseindia.com ListofScripData) is a third feed
#   supplying the BSE group letter + ISIN for the whole ~12,600-row active
#   universe, so classification coverage is complete after one run instead of
#   accumulating over ~10 trading days. It is an UPDATE-ONLY enricher, not an
#   InstrumentProvider — syncInstruments upserts on symbol_exchange and BSE's
#   scrip_id does not always equal Kite's tradingsymbol, so a provider would
#   CREATE duplicates. NOTE its URL uses `segment=Debt`, which is how that
#   endpoint returns the FULL universe (segment=Equity gives 4,926 rows,
#   segment= gives 0); "fixing" it to Equity would drop every bond.
#   No credentials needed.
BSE_MASTER_ENRICH=            # MONEY-1093 kill-switch for the BSE scrip-master
                              # enricher. "off" disables the nightly fetch for
                              # that environment. It shipped as the stopgap for
                              # "BOTH envs scrape api.bseindia.com": the
                              # enricher rides instrument-sync-daily, which is
                              # NOT in PROD_ONLY_JOBS (QA needs the Zerodha dump
                              # from the same job, and instrument_mappings is
                              # QA-DIRECT so it cannot be synced down).
                              # THAT JUSTIFICATION NO LONGER HOLDS in the steady
                              # state. The fetch routes through getFeedAsset
                              # (bse-master-instruments.ts:156), so the feed
                              # archive does cover this feed, and the archive is
                              # now live: verified 2026-08-13 that the prod and
                              # QA buckets each hold exactly one object under
                              # feeds/BSE/scrip-master/current/ at an identical
                              # 4,508,666 bytes — prod written 2026-08-12 22:03
                              # IST by instrument-sync-daily, the QA copy landing
                              # 2h36m later. QA replays those bytes; it does not
                              # touch BSE.
                              # That key is UNDATED — the descriptor passes no
                              # `date`, so buildFeedArchiveKey files it under
                              # `current/` and overwrites in place — so unlike a
                              # DATED feed, QA's 22:00 IST run never races the
                              # 00:45 IST mirror: it always hits, at worst
                              # serving yesterday's master, which is exactly the
                              # "master as it stands now" semantics an undated
                              # descriptor asks for.
                              # Keep the flag anyway. Replay falls back to the
                              # exchange on a miss, so QA reaches BSE again the
                              # moment the key moves or the mirror lags; and on
                              # prod — which WRITES the archive rather than
                              # reading it — this is still the only per-env off
                              # switch for the fetch.
#   MONEY-1093 — REAL ESTATE is its own sector as of 2026-07-30 (13 canonical
#   NSE sectors, not 12). It used to fold into Financial Services, making DLF /
#   Godrej Properties / Oberoi Realty indistinguishable from HDFC Bank in every
#   sector aggregate. Both spellings normalise to it: "Real Estate" (Yahoo/GICS)
#   and "Realty" (NSE + screener). Existing rows do NOT re-bucket themselves —
#   the enrichment pipeline only fetches rows with NO sector — so run
#   scripts/data/resector-real-estate.ts (dry-run default) per environment.

# Raw exchange-feed archive (MONEY-1085) — prod fetches each EXCHANGE file ONCE
# and archives it to GCS; QA replays the same bytes through its OWN ingest
# instead of scraping NSE/BSE. QA keeps its own instrument _ids, so nothing in
# QA is ever dropped. Covered: the BSE + NSE bhavcopies, the NSE all-indices
# close file, the NSE instrument masters (EQUITY_L / SME_EQUITY_L) and BSE's
# scrip master. NOT covered: Zerodha's Kite instrument dump
# (api.kite.trade/instruments) fetches directly — it is an authenticated
# developer REST API, not a scraped exchange site, and it is public,
# tier-agnostic and unmetered, which is why `instrument_mappings` is QA-DIRECT
# in the first place. That exemption is deliberate and machine-checked by
# packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts (MONEY-1157).
#
# LIVE since 2026-08-12 (MONEY-1189 / MONEY-1156): the
# `sync-prod-to-qa-feeds` Cloud Run job mirrors the
# `feeds/` prefix prod bucket -> QA bucket, so QA reads its OWN bucket and needs
# no prod access. Both are provisioned by scripts/ops/setup-sync-job.sh; the
# mirror has run and was verified at 66,951 / 66,951 object parity prod -> QA on
# 2026-08-13. QA then replays those bytes: FEED_ARCHIVE_MODE=replay ships in
# workers/cloudbuild.qa.yaml and is live on the running QA service (revision
# stockbook-workers-qa-00306-hmk); prod stays "archive"
# (workers/cloudbuild.prod.yaml).
#
# MONEY-1194 — the job has TWO triggers, and the pair is load-bearing:
#   `sync-prod-to-qa-feeds-eod`   `15 21 * * 1-5` = 21:15 IST Mon-Fri
#   `sync-prod-to-qa-feeds-daily` `45 0 * * *`    = 00:45 IST daily
# The 00:45 slot alone reasoned only about the PRODUCER (prod's EOD chain) and
# left the mirror landing 3h45m AFTER the CONSUMER: QA runs prod's identical
# chain at prod's identical clock times, so QA's bhavcopy asked for day D's
# date-stamped object at 21:00 on day D and missed 100% (replayHits=0
# replayMisses=2, measured 2026-08-13), falling back to scraping NSE + BSE every
# weekday — silently, because a replay miss is a soft failure by design.
# The ordering that must hold, all on ONE IST calendar day, is
#   21:00 prod ARCHIVES -> 21:15 mirror COPIES -> 21:30 QA REPLAYS,
# which is why `bhavcopy-sync-daily-qa` moved to 21:30. Do NOT collapse the two
# triggers back into one late run, and do NOT "fix" this by moving QA's bhavcopy
# past midnight: `resolveTargetDay` walks back to the most recent trading IST
# CALENDAR day, so a 01:30 run would ask for a file the exchange has not
# published — a silent zero-price no-op. UNDATED feeds (the instrument masters,
# BSE's scrip master) key under `current/`, never rotate, and were always fine.
#
# The sequencing was load-bearing, not incidental: arming replay BEFORE the
# mirror exists is WORSE than leaving it off, because every key misses and
# silently falls back to scraping while the logs claim it replayed — so the flag
# was flipped in the same change that provisioned the job. That same fallback is
# what makes replay safe now that the mirror is real: `resolveFeedArchiveMode()`
# / `getFeedAsset` re-fetch from the exchange on a miss (or on an archived
# object that fails validation), so a late or missing mirror costs one scrape,
# never a failed run.
FEED_ARCHIVE_MODE=            # "archive" on prod, "replay" on QA — both set in
                              # the workers' Cloud Build specs and live on the
                              # running services since 2026-08-12. UNSET =
                              # passthrough (fetch the exchange directly), which
                              # is what local dev gets and the safe default for
                              # any new env.
                              # Needs GCP_STORAGE_BUCKET; without it the
                              # archive stays off and logs a warning.
#   The PAID "Connect" app (live quotes + historical candles + WebSocket ticks)
#   is a FOUNDER-ONLY connector in apps/web (/api/brokers/zerodha-connect) under
#   its OWN keys — never reuse the Personal app keys. Connecting it ONLY stores
#   the encrypted token for the dormant workers/src/connect code (no data sync).
#   ZERODHA_CONNECT_API_KEY / ZERODHA_CONNECT_API_SECRET / ZERODHA_CONNECT_REDIRECT_URI
#   (+ optional CONNECT_FOUNDER_EMAILS CSV; default founder deepshaswat@gmail.com)
# ... other brokers
```

### Datadog Observability

`dd-trace` requires a local Datadog Agent (localhost:8126). On Cloud Run, this
is provided by a sidecar container. On Vercel, APM is disabled - only RUM, Logs,
and Metrics work (via HTTP APIs).

| Service                 | Variable                                   | Required    | Notes                                                    |
| ----------------------- | ------------------------------------------ | ----------- | -------------------------------------------------------- |
| **Workers (Cloud Run)** | `DD_TRACE_ENABLED=true`                    | Yes         | Enable APM tracing                                       |
|                         | `DD_API_KEY`                               | Yes         | GCP Secret Manager (`DD_API_KEY_PROD` / `DD_API_KEY_QA`) |
|                         | `DD_SERVICE=stockbook-workers`             | Yes         | Service name tag                                         |
|                         | `DD_ENV=production/qa`                     | Yes         | Environment tag                                          |
|                         | `DD_VERSION=$COMMIT_SHA`                   | Recommended | Version tracking (set by Cloud Build)                    |
|                         | `DD_TRACE_AGENT_URL=http://localhost:8126` | Yes         | Points to Datadog sidecar                                |
| **Web (Vercel)**        | `DD_TRACE_ENABLED=false`                   | Yes         | No agent available on Vercel                             |
|                         | `DD_API_KEY`                               | Yes         | For logs + metrics via HTTP                              |
|                         | `DD_SERVICE=stockbook-web`                 | Yes         | Service name tag                                         |
|                         | `DD_ENV=production`                        | Yes         | Environment tag                                          |
|                         | `NEXT_PUBLIC_DD_APPLICATION_ID`            | Yes         | RUM application ID                                       |
|                         | `NEXT_PUBLIC_DD_CLIENT_TOKEN`              | Yes         | RUM client token                                         |
|                         | `NEXT_PUBLIC_DD_ENV`                       | Yes         | RUM environment tag                                      |
|                         | `NEXT_PUBLIC_DD_VERSION`                   | Optional    | RUM version tag                                          |
| **API (Vercel)**        | `DD_TRACE_ENABLED=false`                   | Yes         | No agent available on Vercel                             |
|                         | `DD_API_KEY`                               | Yes         | For logs + metrics via HTTP                              |
|                         | `DD_SERVICE=stockbook-api`                 | Yes         | Service name tag                                         |
|                         | `DD_ENV=production`                        | Yes         | Environment tag                                          |

**GCP Secret Manager secrets to create:**

- `DD_API_KEY_PROD` - Production Datadog API key
- `DD_API_KEY_QA` - QA Datadog API key

---

## Job throughput — the 600s ceiling nobody wrote down

Every worker job arrives over a Pub/Sub **push** subscription with a **600s ack
deadline**, which is Pub/Sub's maximum. Cloud Run's own request timeout is
3600s, so it is never the binding constraint — the ack deadline always is.

A handler that runs past 600s is not merely slow. Pub/Sub treats the message as
unacked and **redelivers it**, so a second copy of the same job starts
concurrently, doubling the work and potentially looping (`minimumBackoff` is
10s). That is why every batch size in this repo is what it is:

| Job                             | Batch | Measured           | Headroom                    |
| ------------------------------- | ----- | ------------------ | --------------------------- |
| `financial-data-sync` (retired) | 100   | ~50s               | large                       |
| `mf-metadata-sync`              | 500   | ~490s              | **~18%** — near the ceiling |
| `xbrl-projection`               | 500   | pure DB+arithmetic | large                       |
| `xbrl-ratios`                   | 1000  | pure DB+arithmetic | large                       |

**Raising a batch is not the way to catch up.** `mf-metadata-sync` at 500/run
against 14,225 funds needs ~29 weekly runs, and it cannot go bigger — it is
already at ~82% of the deadline, and almost all of that is an explicit
`delayMs: 1000` per fund. The AMFI snapshot is fetched ONCE and memoised at
module scope, so that delay is not protecting an upstream from anything. The
levers, in order of preference: drop the per-item delay, run daily for a few
weeks, or self-chain (process a batch, publish a follow-up message).

Two related rules that also cost real time:

- **A batch must be a MULTIPLE of the population's duplication factor.** A
  `take` counted in ROWS over a table where one logical unit occupies several
  rows silently returns fewer distinct units than asked for (MONEY-1207: a
  quarter both exchanges filed occupies two rows).
- **A batch needs a rotation MARKER, ordered ASC, or it never advances.**
  Ordering by a column that is constant across the population hands every run
  the same first N rows forever — they get written once and skipped nightly
  while the rest are never selected. No error, no alert, no data (MONEY-1211:
  681 of 781 symbols).

---

## Development Commands

```bash
# Install dependencies
yarn install

# Run all apps in dev mode
yarn dev

# Run specific app
yarn workspace @usemoney/web dev
yarn workspace @usemoney/api dev

# Build all
yarn build

# Run tests
yarn test

# Lint
yarn lint

# Type check
yarn type-check

# Database
yarn workspace @usemoney/database prisma generate
yarn workspace @usemoney/database prisma db push
```

---

## Codex Automation (Loops & Verification)

The dev workflow encodes its quality gates as deterministic loops — skills,
scripts, and hooks — instead of per-session memory.

### Verification gate (before every push)

```bash
yarn verify:push                 # yarn build + yarn test --force → .Codex/.verify-ok
VERIFY_SERIAL=1 yarn verify:push # serialized fallback for parallel TASK-level flakes
```

On success it writes a gitignored marker keyed to a content hash of the exact
tree it verified (commit/staging changes keep it valid; any file edit
invalidates it). `.Codex/hooks/pre-push-gate.sh` is the PreToolUse hook that
blocks Codex's `git push` without a fresh marker (registered in
`.Codex/settings.json`; emergency bypass: `VERIFY_GATE_BYPASS=1 git push …`,
hotfixes only). The `verify-before-push` skill is the full ladder: build →
suite → coverage doc → runtime proof → review.

### TEST-COVERAGE.md freshness

```bash
yarn test:coverage-check   # scripts/gen-test-coverage.ts --check
```

Fails when the doc's "Total Test Files" headline drifts from the on-disk
inventory. Runs warn-only in CI (`test.yml`) until the next full recount
restamps the headline — then make it blocking.

### Loop recipes

```bash
# Goal loop — anything with a deterministic exit (upgrades, red→green, de-shadow):
/goal yarn verify:push passes end-to-end (build + full suite green), stop after 5 tries

# PR babysitting — after pushing a branch:
/loop 10m /babysit-pr <PR# or branch>   # merge-detect → (gh) fix CI → post-merge cleanup → end

# Recurring ops — daily triage routine lives in /schedule (Datadog + PostHog errors +
# Linear board → triaged MONEY tickets).
```

Skills = the constraint, loops = the persistence: a goal loop chasing "green"
without `fixing-bugs`/`writing-tests` loaded will happily weaken a test to get
there. Both halves are required.

### Review (repo has no human reviewer)

Owner is approval-exempt, so a fresh-context agent review is the only review:
run `/code-review` on the diff before every PR; money paths (payments/Dodo,
broker sync/tokens, auth/middleware, entitlements) get `/code-review ultra`.
Recurring defect classes get encoded back into the `fixing-bugs` /
`writing-tests` skills.

---

## Data Seeding & Ops Scripts

```bash
# Multi-environment database seeding
./scripts/seed-env.sh qa              # Seed QA database
./scripts/seed-env.sh prod            # Seed Production database
./scripts/seed-env.sh all             # Seed both
./scripts/seed-env.sh prod --step 3   # Run only step 3
./scripts/seed-env.sh prod --from 3   # Run steps 3-5

# Cloud Scheduler setup
./scripts/ops/setup-scheduler.sh qa       # QA schedulers
./scripts/ops/setup-scheduler.sh prod     # Prod schedulers
./scripts/ops/setup-scheduler.sh all      # Both

# Pub/Sub setup
./workers/scripts/setup-pubsub.sh qa  # QA topics & subscriptions
./workers/scripts/setup-pubsub.sh prod # Prod topics & subscriptions
```

---

## Deployment

### Web App (Vercel)

- Auto-deploys from `main` branch
- Preview deployments for PRs
- Edge functions for streaming

### API Server (GCP Cloud Run)

- Docker container
- Auto-scaling based on traffic
- Deployed via Cloud Build

---

## What's Been Completed

### Core Infrastructure

- [x] Monorepo setup with Turborepo
- [x] Database schema with Prisma
- [x] Multi-layer caching system
- [x] Clerk authentication integration
- [x] Error sanitization utilities

### Broker Integration

- [x] Zerodha full integration (Holdings, Positions, Trades, MF)
- [x] Upstox integration
- [x] Angel One integration
- [x] Groww integration
- [x] Dhan integration
- [x] Fyers integration
- [x] OAuth flow for all brokers
- [x] Token refresh handling

### Portfolio Features

- [x] Dashboard with portfolio summary
- [x] Holdings view with grouping
- [x] Positions view (day/overnight)
- [x] Trade book with FIFO pairing
- [x] Mutual funds tracking

### Trade Import

- [x] CSV import with broker format detection
- [x] Duplicate detection (cross-source)
- [x] Import history management
- [x] Background processing with progress

### Paper Trading

- [x] Virtual portfolio management
- [x] Buy/Sell simulation
- [x] P&L tracking

### FIRE Planning

- [x] Multiple scenario support
- [x] SIP/Lump sum calculations
- [x] Visualization

### Premium Features

- [x] Subscription management (Dodo)
- [x] AI chat integration (Gemini)
- [x] Secure content delivery (GCS)

### SEO & Meta

- [x] robots.txt, sitemap.xml
- [x] OpenGraph/Twitter cards
- [x] llms.txt for AI crawlers

### New Features & Integrations

- [x] Demo session system (HMAC-signed cookies)
- [x] Portfolio roast analysis (AI-powered)
- [x] Risk analysis dashboard
- [x] Notification system
- [x] Watchlist management
- [x] Document management & processing
- [x] AI research with multi-skill agent
- [x] Slash commands in AI chat
- [x] Quiz & learning system
- [x] Stock/MF discovery with Atlas Search
- [x] Market indices integration
- [x] Tax analysis
- [x] Multi-environment seeding scripts
- [x] Cloud Scheduler setup scripts
- [x] Datadog APM integration (workers)
- [x] Fund composition analysis (on-demand)
- [x] Derived stock peers (`peers-sync` worker; MONEY-1145 — replaced a tab that
      was empty platform-wide with peers computed from our own instrument,
      ratio and quote data, so no third-party scrape and no rate limit)
- [x] Data Engine Wave 2 (MONEY-1186 epic — `feat/MONEY-1186`): - **P11 positioning** (MONEY-1187) — participant-wise F&O long/short from
      `fao_participant_{oi,vol}`. NO new egress: prod had been archiving both
      families since P2 (1,636 files each), so this was the missing PARSE.
      India VIX turned out to be already covered (`index_closes.indexSlug =
"india-vix"`, 3,019 rows back to 2014) — nothing to build. MWPL and EGR
      have ZERO archived files because their registry paths 404; those are
      URL-DISCOVERY tasks, not parse tasks, and must not be estimated as if
      they were. **WDM and CBM are no longer in that set** (MONEY-1201): NSE's
      own report index (`/api/daily-reports?key=CBM|WDM`, the same door that
      unblocked SLB in MONEY-1200) publishes every real path, and all 17
      families are now registered and probed. Two cautions came out of it and
      both generalise. (a) The index is AUTHORITATIVE BUT NOT INFALLIBLE — it
      was seen emitting a half-substituted `/content/historical/WDM/20wdmlist_…`
      whose `{YYYY}/{MON}/` segments never got filled, so read the index, then
      FETCH EVERY PATH IT GIVES YOU. (b) Finding a path is not the same as being
      able to fetch it nightly: only 4 of the 17 (`cbm_trd`,
      `Corporate_bond_report`, `wdmlist`, `dly.zip`) publish day D's file ON day
      D and ship `enabled`. The other 13 (`/content/cbm/`, `/content/cd/`,
      `/content/sdi/`, GSEC) first appear on D+1, and both nightly passes
      (19:30 + 21:45) target day D — so enabling them would 404 every weekday
      forever, indistinguishably from a market holiday. They ship
      `enabled:false, backfillable:true` (the backfill-only quadrant) with the
      exact flip-experiment written into their notes. `nse-corpbond` and its
      `CBM-CORPBOND` fileKey stay unfound — that key is not in the live CBM
      payload at all. - **P10 XBRL** (MONEY-1113/1114/1115) — company financials from NSE's own
      filings, the F2 backfill, and the F3 projection + Tickertape
      reconciliation gate that has to run BEFORE the first write (once XBRL
      writes a period, `StockFinancials` has no `source` in its key and the
      incumbent value is gone, so there is nothing left to reconcile
      against). **NSE's results index is TWO endpoints** split at SEBI's
      integrated-filing regime — the documented one went quiet at Dec-2024
      (2,402 records for Nov-2024, **31** for Nov-2025) — and the modern one
      **caps at 20 records** by default while reporting `totalCount` in an
      envelope that is easy to discard. - **P8a MF portfolios** (MONEY-1105) — SEBI-mandated monthly holdings for
      3 of the top-5 AMCs. ABSL and Kotak are deliberately NOT fetched: their
      URLs are unproven, and a guessed URL 404s identically to "not published
      yet". Nippon keeps only the CURRENT month, so its schedule carries the
      risk rather than its parser. - **P11 circulars + Market Pulse** (MONEY-1187) — `circNumber` is NOT
      unique (NSE re-issues one circular per department; 205 distinct numbers
      across 237 records), and the Market Pulse PDF family is registered with
      its TWO indistinguishable 404 causes written down. - **P9 commodities** (MONEY-1110/1111/1112) — PARSE built against real
      fixtures; the FETCH stays blocked (MCX 403s our egress, NCDEX presents
      a JS fingerprint challenge).

---

## What Needs to Be Done

### High Priority

- [ ] Live market data integration (Yahoo Finance + TradingView charts (UDF
      endpoints + bundled `charting_library`) shipped; LIVE broker quotes
      remain founder-only via the dormant Zerodha Connect app — see
      MONEY-837 notes in Environment Variables)
- [ ] Mobile app API completion

### Medium Priority

- [ ] Historical performance charts
- [ ] Dividend tracking
- [ ] Corporate actions (splits, bonuses)

### Low Priority

- [ ] Social features (share portfolio)
- [ ] Price alerts for watchlist

---

## Restrictions & Guidelines

### Code Quality

- TypeScript strict mode everywhere
- No `any` types (use `unknown` if needed)
- All exports must be typed
- Tests for critical business logic

### Security

- Never log sensitive data (tokens, passwords)
- All broker credentials encrypted
- Sanitize all user-facing error messages
- Validate all inputs with Zod

### Performance

- Use caching for expensive operations
- Avoid N+1 queries
- Stream large responses
- Optimize bundle size

### Architecture

- Business logic in `packages/core`
- Database operations via Prisma only
- No direct DB access from components
- Use server actions for mutations

---

## Test Coverage

The single source of truth for test coverage is
[`TEST-COVERAGE.md`](./TEST-COVERAGE.md) in the repo root.

**Current stats:** see [`TEST-COVERAGE.md`](./TEST-COVERAGE.md) for the
authoritative file/case counts and per-file coverage. Hard numbers are
deliberately NOT duplicated here — the old "271 files / 11,501 cases" had drifted
by thousands (actual is ~690 files). `TEST-COVERAGE.md` is the single source of
truth (MONEY-838).

**Test runner:** Node.js native (`node:test` + `node:assert/strict`), executed
via `yarn test`.

> **The test glob MUST stay quoted** — `--test "__tests__/**/*.test.ts"`. Left
> unquoted, the shell expands `**` as a single `*`, so only files exactly one
> directory deep are passed to node. Worse, it failed ASYMMETRICALLY: where the
> shell glob matched nothing (e.g. `packages/research`, whose files sit directly
> in `__tests__/`) the literal pattern reached node, whose glob IS recursive, and
> everything ran. Where it matched something (`apps/web`) the shell won and
> silently truncated the set — 45 files / 3,093 cases never executed, including
> every broker-adapter test and both sector-taxonomy files, while
> `TEST-COVERAGE.md` counted them. The pattern only worked in the workspaces
> where it failed. Quoting hands expansion to node everywhere (MONEY-1093).

> **Rule:** Whenever a test file is added, removed, or modified,
> `TEST-COVERAGE.md` MUST be updated:
>
> - Add/remove the test entry in the appropriate section
> - Update test case counts and coverage percentages
> - Move source files between "Tested" / "Not Tested" as needed
> - Update the totals in the Overall Coverage Summary table

---

## Contributing

### Branch Naming Convention (Enforced)

All branches **must** follow: `{type}/MONEY-{number}` - **text descriptions are
not allowed.** The Linear ticket is the source of truth for what the branch is
about.

| Type       | When to Use                            |
| ---------- | -------------------------------------- |
| `feat`     | New feature or capability              |
| `fix`      | Bug fix                                |
| `test`     | Adding or updating tests               |
| `chore`    | Maintenance, dependencies, config      |
| `docs`     | Documentation only                     |
| `refactor` | Code restructuring, no behavior change |
| `perf`     | Performance improvement                |
| `ci`       | CI/CD pipeline changes                 |
| `build`    | Build system or tooling                |
| `style`    | Code style, formatting                 |
| `hotfix`   | Urgent production fix                  |

**Examples:**

```
feat/MONEY-85
fix/MONEY-108
test/MONEY-112
```

**Enforcement:**

- Local: Husky `pre-push` hook blocks pushes with invalid branch names
- CI: GitHub Actions `pr-branch-check` workflow fails PRs with invalid branches
- Every PR must be linked to a Linear ticket (team key: `MONEY`)

**Exempt branches:** `main`, `release`, `develop`, `dependabot/**`

### Workflow

1. Pick a Linear ticket from the
   [UseMoney board](https://linear.app/dis-digital)
2. Create branch: `git checkout -b {type}/MONEY-{number}`
3. Follow existing code patterns
4. Add tests for new features
5. Update `TEST-COVERAGE.md` when adding/changing tests
   (`yarn test:coverage-check` must pass)
6. Update relevant AGENTS.md files
7. Run the verification gate (`yarn verify:push`) and a fresh-context review
   (`/code-review`; money paths → `/code-review ultra`) — this repo has no
   human reviewer
8. Create PR with clear description - the PR template auto-populates
9. PRs require approval before merge (owner `deepshaswat@gmail.com` is exempt)

---

_Last Updated: August 2026_
