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

| Layer          | Technology                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Frontend**   | Next.js 16.2, React 18, TypeScript, Tailwind CSS, shadcn/ui                                                                                        |
| **Backend**    | Next.js API Routes, tRPC, Hono (API server)                                                                                                        |
| **Database**   | MongoDB Atlas (via Prisma ORM)                                                                                                                     |
| **Cache**      | Redis (DigitalOcean) with multi-layer caching (Memory + Redis)                                                                                     |
| **Auth**       | Clerk (authentication & user management)                                                                                                           |
| **AI**         | Google Gemini (3.1 Pro + 3 Flash previews; see `packages/core/src/gemini/model-registry.ts`) + Claude router (allowlist OR paid plan — MONEY-1274) |
| **Payments**   | Dodo Payments                                                                                                                                      |
| **Storage**    | Google Cloud Storage (GCS) for learning content                                                                                                    |
| **Messaging**  | Google Cloud Pub/Sub (job queuing)                                                                                                                 |
| **Deployment** | Vercel (web), GCP Cloud Run (API & Workers)                                                                                                        |
| **Monorepo**   | Turborepo with Yarn workspaces                                                                                                                     |

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

### QA has NO Atlas Search — and therefore no Vector Search (MONEY-1503)

**Prod's MongoDB is Atlas. QA's is not** — it is the self-hosted
`usemoney-qa-mongodb` GCE instance, the same VM the Datadog GCP integration
discovered as a billable infra host. Self-hosted MongoDB has no `mongot`, so
`$vectorSearch`, `$search` and `$listSearchIndexes` all fail there with

```
Error code 31082 (SearchNotEnabled)
```

Measured 2026-09-22. This is a DECISION (founder, same day), not a defect to
fix: an M0 free tier caps at 512 MB and QA alone holds 987,154
`document_embeddings` rows, so a second cluster would not buy a rehearsal
either.

**What it means in practice, and it is not "QA is dark".** Every Atlas-Search
consumer in this repo already has a non-search fallback, and QA exercises it:

| Surface                   | QA path                                                                        |
| ------------------------- | ------------------------------------------------------------------------------ |
| research filing context   | `$vectorSearch` THROWS -> `catch` -> in-memory cosine over the symbol's chunks |
| instrument / stock search | Atlas Search on prod, regex in QA (the pre-existing dual path)                 |

**The failure modes differ by environment, and that is the part worth
remembering.** In QA a search call ERRORS, so the `catch` fires and the
fallback runs. On prod a mis-typed filter can return an EMPTY RESULT WITHOUT
THROWING, so the `catch` never fires and the fallback is unreachable. That is
exactly MONEY-1500: a `userId` filtered as a bare string matched nothing on
prod for the whole research corpus and every user's document search, while QA
was reaching its fallback the entire time. **A green QA does not evidence a
working prod search path, and vice versa.**

**So anything depending on Vector Search is PROD-FIRST by construction** — the
embeddings v2 backfill, its parity run and the v1 rename included. Do not plan
a QA rehearsal for them; there is none to have. The compensating control is
`apply-atlas-search-indexes.ts --probe --apply`, which answers the two
silent-when-wrong unknowns (does subtype-9 BinData survive `$runCommandRaw`,
does Atlas accept a BinData `queryVector`) in about a minute against a
throwaway prod collection, plus the parity gate, plus the fact that the
migration renames v1 and keeps it 30 days rather than dropping it.

QA's lake silver is a nightly COPY of prod's (`sync-prod-to-qa-lake`, 02:30 IST,
MONEY-1610 — live once `setup-sync-job.sh` has run after the merge), so
QA-originated silver writes (`event-lake-sink-qa`) are overwritten each night.

### BigQuery DATE/TIME params must be `Date` objects, never strings (MONEY-1538)

`@google-cloud/bigquery` serialises a `DATE` / `TIMESTAMP` / `DATETIME` / `TIME`
param by reading `value.value` — present on a JS `Date` (converted for you) or
a `BigQuery.date()` object, ABSENT on a string — so a string is DROPPED and the
param reaches BigQuery with no value, i.e. NULL. `x >= NULL` matches nothing,
so no error is ever raised. Both month DELETEs in `packages/lake/src/load.ts`
were no-ops from the day they shipped: every lake RE-load (a retried month, a
superseded month, a parser-version reload) appended a second copy — 315,609
duplicate rows on prod before it was seen, 2026-09-23. They now bind STRING and
`PARSE_DATE('%Y-%m-%d', @x)` in SQL, and a test serialises every param through
the client's own `valueToQueryParameter_`. Assert what the CLIENT SENDS, never
the params object you built.

### India daily charts: one series, each action applied once (MONEY-1382 / MONEY-1541)

India 1D/1W/1M on the legacy `/udf/history` route come from `daily_prices`.
Exchange rows are RAW; a Yahoo row carries `adjustedThrough = createdAt` and
receives only the actions AFTER it (Yahoo had applied the rest —
`adjustBarsForBasis`). 1W/1M are resampled from ADJUSTED daily bars and dated at
their first session. Today's candle comes from a quote ≤60 s old, only while the
NSE session is live, and is never cached. Yahoo never gap-fills a window that
has exchange rows; intraday stays Yahoo by design. **Prod charts read TILES**
(`MARKET_DATA_TILES=true` since 2026-09-17), so the same rule had to reach
`tile-build-d1` — MONEY-1541, with the chart's own action query, and tile
policy v2 forcing one deep rebuild so closed years are rewritten too.
MONEY-1543: the chart and the tile builder load actions through
`loadAdjustingActions`, and the marks route applies the same
`refuseForeignIssuers` — a row whose ISIN issuer (chars 3-7) is known and
differs from the listing's is refused (FOCUS, WORTHPERI, ZEAL, RAJPUTANA); an
unknown issuer stays admitted and is counted. That code attributes an action; it
does not rank one: `query_lake`'s `universe_top_by` groups by the FULL ISIN,
because chars 3-7 merged 1,406 distinct securities on prod (AMC ETFs, bonds,
GATECH/GATECHDVR). `query_lake` is planned only when `LAKE_ENV` is set (the
reader grant is MONEY-1605). It refuses, by name and uncached, an empty
answer the lake cannot vouch for (no sessions for the listing), so India's
two-part-id gap reads as a refusal, not "no events".

### Gold is built by the Dataform CLI in a Cloud Run job (MONEY-1611)

`lake-gold-{env}` runs `dataform run` over the `dataform/` baked into the workers
image, as `lake-dataform-{env}@`, at 06:45 and 20:15 IST — no managed Dataform,
no Git token, and it builds exactly the release's SQL. The CLI is `npm ci`'d
from `tools/dataform-cli`'s lockfile (not a yarn workspace), and the image build
compiles both envs OFFLINE, so a project that does not compile fails the workers
release. CLI 3.0.0 exits 0 when an `--actions` name matches nothing, so the
verdict reads the transcript per requested name; a failed assertion is always a
non-zero exit. It will not build over a silver input a LEDGER-CLAIMED loader
(`lake-replay-*`, `lake-load-databento`) is mid-reloading: a live LOADING claim,
or any ledger claim in the last 30 min (a replay walks month by month, so
LOADING alone misses the gap between months), skips with SKIPPED_LOADING — exit
0 for a scheduled slot, non-zero for a targeted or `--full-refresh` run, which
would otherwise silently never happen. `identity-sync` and
`corp-action-lake-sink` take no claim, so the gate cannot see them: do not run
them beside a gold build. `event-lake-sink` (hourly at :10) takes none either but
is safe mid-build — it deletes only rows whose replacement is already present. After a historical replay, full-refresh
`event_return_outcome` — its COMPLETE rows are never re-read.
`adjusted_bar_d1`'s OHLC rule checks the ADJUSTMENT, not the source (MONEY-1619):
a bar whose raw order holds must keep it after adjustment. 31,992 raw bars break
OHLC order in the exchanges' and Tiingo's own files (NSE 1996 LAKSHMILL open 585 >
high 570); a positive factor cannot reorder prices, so those are source data, not
a gold failure.

### The NSE holiday list is TRANSCRIBED from NSE's circular, never shifted (MONEY-1615)

`nse-holidays.ts` FY 26-27 held 2025's dates with the year changed, so every
walker skipped 2026-08-27 — a real trading day — and nothing archived it; 21–22
Oct 2026 would have gone the same way. It now copies NSE/CMTR/71775 (12-Dec-2025)
row for row and a test pins it. NSE publishes by CALENDAR year each December, so
Jan–Mar of the next year holds only fixed-date holidays until that circular
lands: a wrong holiday SKIPS a session, which is worse than a missing one.

### India weekend special sessions (MONEY-1613)

Muhurat, Budget and DR Saturdays trade on a weekend, and every walker skips
weekends. `india-special-sessions.ts` is a checked-in calendar of 45 measured
weekends — DATES TO TRY, never sessions (93 dates). `feed-backfill
--special-sessions` archives a weekend file only when its OWN date column is that
day (`checkSessionDate`, inside `getFeedAsset` before the write), so a stale copy
never lands under a weekend key. `lake-replay-in` reads the calendar dates; once
the weekend key exists, the next weekday's stale delivery copy is a byte-identical
duplicate (MONEY-1612's rule) and the month accepts. A calendar date with no file
is never expected. BSE `eq{DDMMYY}_csv.zip` has no date column and can never prove
a weekend session.
The four delivery months resolve only if NSE serves the weekend key md5-identical
to the Monday copy; the own-DATE1 fallback is not built. `feed-parse-nightly` writes
every archived weekend file into Mongo the same night.

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
ANTHROPIC_API_KEY=...        # MONEY-626 Claude router: enables Claude models in chat + research (worker runtime + eval)
CLAUDE_PORTFOLIO_AGENT=      # set "off" to kill Claude entirely (everyone falls back to Gemini)
CLAUDE_ALLOWED_EMAILS=       # optional CSV allowlist; unset = the founder
                             # (deepshaswat@gmail.com). Gemini remains the
                             # default model for all users.
                             #
                             # MONEY-1274 (MONEY-1155 #27) — the allowlist is no
                             # longer the ONLY door. Claude is now reachable on a
                             # PAID PLAN too: a restricted model is allowed when
                             # the user's plan satisfies that model's own
                             # `requiresPlan`, which every Claude entry declares
                             # as "PRO" — so PRO and PREMIUM both reach it and
                             # FREE does not. Narrowing Claude to PREMIUM is a
                             # one-field edit on those five registry entries, not
                             # a code change; that is the point of routing
                             # through `requiresPlan` rather than adding a second
                             # gate.
                             #
                             # The allowlist survives as an OVERRIDE: the founder
                             # keeps access on any plan, and this var is still the
                             # way to add interns without a subscription.
                             # `isClaudeConfigured()` stays the floor — no key or
                             # CLAUDE_PORTFOLIO_AGENT=off means no Claude for
                             # anyone, plan regardless.
                             #
                             # ONE rule, `isClaudeEntitled` (model-registry.ts),
                             # is read by BOTH the picker and the chat route.
                             # Widening only the picker would show a subscriber
                             # Claude and then silently answer with Gemini.
                             # Cost is unchanged and metered: Opus carries
                             # creditPremium 4.
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
# QUARTERLY). That job is RETIRED.
#
# THE PROD SCHEDULER IS ALREADY GONE. Verified 2026-08-21: `gcloud scheduler
# jobs list --location=asia-south1` lists neither `financial-data-sync-weekly`
# nor `ratios-sync-daily` in any env — `OLD_SCHEDULER_PREFIXES` in
# setup-scheduler.sh deleted both. Nothing publishes to the topic any more.
# What is STILL STANDING is the Pub/Sub plumbing, and only that:
#
#   topics         financial-data-sync-{qa,prod,local}
#   subscriptions  financial-data-sync-prod-push, -qa-push, -local-pull-local
#
# Three inert topics with no publisher. The route survives to keep them
# harmless rather than to serve a live schedule: it answers 200 `{retired:true}`
# and DROPS the message, because Pub/Sub ACKs only on 2xx — a semantically-tidy
# 410, or a deleted route's 404, would NACK and burn five delivery attempts plus
# a dead-letter alert per message. Teardown is a founder action and is ordered
# subscriptions FIRST, then topics (deleting a topic under a live subscription
# leaves the subscription orphaned rather than removing it).
#
# Two nightly jobs replace it, both reading only our own tables:
#   xbrl-projection-daily  23:45 IST      -> StockFinancials (ANNUAL + QUARTERLY)
#   xbrl-ratios-daily      22:00 Mon-Fri  -> StockRatios, after bhavcopy lands
#                                            the close at 21:00
#
# QUARTERLY IS REAL NOW — it was not, and "ANNUAL + QUARTERLY" above was a
# statement of intent for two releases (MONEY-1235). `stock_financials` held
# ZERO quarterly rows against 71,450 quarterly filings in `xbrl_filings`, and
# the reason was structural rather than data: with no quarterly row to update,
# EVERY quarterly write is a CREATE, and creates were unreachable. Two defects,
# both fixed:
#
#   - `createMissing` had no field on the message and no forwarding in the
#     route, so the writer's documented "separate, opt-in step" could not be
#     opted into and was false in every production run that ever executed. It is
#     now a real message field (`createMissing:true`), still defaulting FALSE —
#     a create is a row the reconcile never compared, which is exactly the risk
#     the interlock exists for.
#   - The writer stamped `projectedAt` on CREATE-SUPPRESSED filings. `decidedIds`
#     was filled for a whole symbol group BEFORE any statement was written and
#     the create branch returned without touching `failedIds`, so a suppressed
#     filing was recorded as decided having produced nothing. Armed, that burns
#     a page of quarterly filings per night into stamped-never-created and the
#     later deliberate pilot then selects none of them — recoverable only by a
#     hand `$unset`.
#
# Filling the table is now an OPERATIONAL step, not a code gap: a small
# hand-checked `createMissing` pilot, then a sized drain. Sequence and the
# per-run arithmetic are in docs/reference/xbrl-switchover-runbook.md. Until the
# drain runs, `xbrl-projection-daily` carries a TEMPORARY
# `{"periodTypes":["ANNUAL"]}` payload so unstamped quarterly filings cannot
# starve the annual work the switchover gates on (the read is symbol-major, so
# the two buckets interleave); it reverts to `{}` when the drain completes.
#
# MONEY-1300 — THE POLICY IS RATIFIED AND IT IS CONSOLIDATED-PREFERRED.
# Founder decision 2026-08-31, Option 1: one row per period, standalone as
# fallback, `basis` stamped, readers badge it. 1,786 of 2,467 symbols (72%) file
# BOTH bases; 664 are standalone-only (NSE publishes no consolidated for most of
# them — correct, not a gap) and 17 consolidated-only. This was already what
# `STANDALONE_NO_DISPLACE` did — 3,208 of 10,879 winner periods, 29.5% — and it
# had never been ratified.
#
# It destroys nothing: `XbrlFiling`'s key CARRIES `basis`, so both filings are
# kept forever (63,575 STANDALONE + 44,447 CONSOLIDATED of 108,022). A sibling
# standalone table costs the same to build later as now, so it is deferred until
# a reader needs it rather than built on spec.
#
# The 32,359 vendor rows are stamped `basis: "UNKNOWN"` — a NAMED value, never
# absent and never null, so no one ever writes `{basis: null}` (which matches
# nothing, in both directions, on a field a `db push` never created).
#
# `stock_financials` also gained `basis` (CONSOLIDATED | STANDALONE), written by
# the projection on every create and update. A company files BOTH for one period
# and they differ by a MULTIPLE for any holding company — 360ONE FY2025
# totalAssets is 19,768 Cr consolidated against 7,332 Cr standalone — and
# `XbrlFiling` keeps both because its key carries `basis` while this table's key
# does not. So one row holds one of them and, until now, said nothing about
# which. It is DELIBERATELY NOT in the `@@unique`: adding it would make
# consolidated and standalone two rows for one period, which every reader
# (research tools, the Financials tab, the reconcile gate) would double-count
# while looking entirely normal. It is provenance for READERS, never a guard —
# NEVER filter it with `basis: null`, because a Mongo `db push` creates indexes
# and not fields, so the attribute is ABSENT on all ~32,359 pre-existing rows
# and both `{basis: null}` and `{basis: {not: null}}` return ZERO. That class
# has now caused MONEY-1050, MONEY-1234 and MONEY-1235.
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
# BSE ATTACHMENT RETENTION — measured 2026-08-29, and it looks like a broken
# run. BSE stops serving corpfiling attachments for older filings. Measured on
# prod across `stock_documents` quarterly_result rows, with bytes vs without:
#
#   2019-2025    0-1% empty     attachments served normally
#   2018          75% empty     partial
#   2017         100% empty     nothing served
#   2016          89% empty     nothing served
#
# So `bse-backfill` walking 2016 stored 0 of 4,299 attachments and stopped
# itself with "NOT CHAINING (no-attachments)" — CORRECT behaviour, not a
# failure. Its diagnostic used to guess "Almost always missing GCS config",
# which is wrong and expensive: the job's env is fine, the pinned image DOES
# contain the AttachLive/AttachHis fallback (MONEY-1258), and BSE was serving
# 14,296 attachments successfully that same day through the nightly sync. The
# message now leads with the year table instead of a guess.
#
# 6,125 rows carry `gcsPath: ""` as a result. They are NOT corrupt and NOT
# worth re-running: metadata, title, description and `sourceUrl` are all
# present, which is the useful part, and the PDF no longer exists upstream.
# Do not re-run a shard below ~2018 — it spends thousands of requests against a
# rate-limiting host to store nothing.

# screener.in is still used, for DOCUMENTS and corporate actions
# (stock-document-sync, corp-actions enrichment). This section used to say it
# ALSO writes `StockFinancials` at request time through
# `persistFinancialFallbackInBackground`. CORRECTED by the MONEY-1235 audit —
# two things were wrong:
#
#   1. THAT PATH IS DEAD IN PRACTICE. `fetchFinancialsChain` starts AND ends at
#      Screener since MONEY-1220 (Tickertape's rung was removed — 403 from our
#      egress), and `ScreenerFinancialData` carries `annualRevenue` /
#      `annualProfit` / `annualRoe`. It has NO `income`, `balanceSheet` or
#      `cashFlow` array. The three research tools read exactly those three keys
#      off the chain result (`fetch-income-statement.ts:198`,
#      `fetch-balance-sheet.ts:203`, `fetch-cash-flow.ts:184`), get `undefined`,
#      map zero rows, and the `if (annual.length > 0)` persist branch never
#      executes. The only shape that ever satisfied it was TICKERTAPE's, and
#      Tickertape is out of the chain. So there is no request-time SCREENER
#      write to `stock_financials` today.
#   2. It does NOT "clear `mayOverwriteFinancials` first". It CHECKS it
#      (`persistence.ts:291`) and `continue`s on false, counting an
#      `authoritySkip`. The guard is a read, not something a writer disarms.
#
# The authority ordering the old note leaned on is correct and worth keeping,
# because it is what makes the dead branch SAFE rather than merely unused:
# FINANCIALS_AUTHORITY is NSE_XBRL > TICKERTAPE > SCREENER > YAHOO (unknown
# ranks LAST, so a new upstream can only fill a gap). If a future Screener
# parser did start emitting statement arrays and woke the branch up, it could
# still only land in an empty cell or over YAHOO — never over NSE_XBRL or
# TICKERTAPE — and the nightly projection would displace it. Left as-is by
# MONEY-1220 and MONEY-1235: guarded, weakest by declared authority, and as of
# this audit not running at all.
#
# The screener DOCUMENTS leg is a separate question and it IS live. That
# "unaffected" claim rests on PROD evidence — workers stored 49
# announcements, 60+ annual reports and credit ratings in the week of
# 2026-08-19 — NOT on a laptop 200, which is precisely the reading that hid
# Tickertape's block for five months. `API_LIMITS.screener` was cut 2000 -> 500
# after MONEY-853, where a whole-market run hit a per-IP 429 wall and ZERO
# screener data reached GCS while Tickertape's leg landed normally: the same
# silent-partial-failure shape, from a rate limit rather than a block.
#
# RETRACTED BY THE MONEY-1255 AUDIT. This paragraph used to say
# `stock-document-sync` "STILL scrapes `www.tickertape.in/stocks/<sid>`" for
# formatted statement text, and that `TT=0` in its job outcome would settle
# whether our egress is blocked on the www host. BOTH HALVES ARE FALSE, and the
# second one mattered: it nominated this job as a probe it can never be.
#
# The job issues NO REQUEST to any Tickertape host. `TICKERTAPE_BASE`
# (`stock-document-sync-logic.ts:224` — the old note cited :202, which had
# moved) is read by exactly one function, `buildTickertapeUrl`, whose only two
# callers write the `sourceUrl` COLUMN on the upsert
# (`stock-document-sync.ts:565` and `:574`). The leg's actual data source is
# `getOrFetchFinancials`, a pure Prisma read of `stock_financials`
# (`packages/research/src/data-sources/db-store.ts` — "Deliberately NO external
# fetch here"). So `TT=250` reported 250 DATABASE LOOKUPS and `TT=0` could never
# occur, in any weather. `API_LIMITS.tickertape = 5000` is a per-run cap on
# those lookups.
#
# Grep confirms it repo-wide: `www.tickertape.in` appears in exactly one
# non-test source line, the constant above. Every live Tickertape call in the
# repo goes to `api.tickertape.in` (the research clients), and
# `tickertape-client.ts:29` already records that the www host "blocks
# non-browser requests (404/403)" — so the citation URLs we store point at a
# host that would not serve us either.
#
# MONEY-1228's Cloud Run probe is therefore still UNANSWERED and still needs to
# be its own measurement. What `stock-document-sync` does now report honestly is
# documents WRITTEN per source plus a `transportFailures` count, so a genuinely
# dark NSE or Screener leg is visible; before MONEY-1255 every per-source
# counter was incremented BEFORE the call it counted, so a source that 403s on
# every request still produced a full-looking number — the exact reading that
# hid Tickertape's block for five months, rebuilt one layer up.
#
# Do not read "Tickertape is gone" off this section; read "Tickertape supplies
# neither financials nor ratios, and no job in this repo fetches from it except
# the research clients on `api.tickertape.in`".
#
# Known limits, written down rather than discovered later: NSE FILERS ONLY IN
# THE DATA (108,020 filings, `exchange` "NSE" on every row) — but that is an
# UNFLIPPED SWITCH, not a missing capability, and this line said "no BSE XBRL
# ingest exists" for two releases while the ingest sat built and tested.
# MONEY-1255 shipped it DISARMED: `bse-results-xbrl` in
# `packages/core/src/market-data/report-registry.ts:1985` reads "WIRED BUT NOT
# ARMED. Arming is a founder step", alongside the BSE index path, the
# NBFCUploadDocument -> IFNBFCUploadDocument 404 workaround, and
# `resolveWritableSymbol` for BSE-only issuers that file <Symbol>NOTLISTED.
#
# The real gate is DATA, not code: a BSE-only issuer resolves through
# `InstrumentMapping.bseScripCode`, and only 581 of 10,381 BSE rows carry one
# (330 of the 2,414 target companies). The BSE results index is keyed by scrip
# code and takes no date range, so without that bridge there is nothing to
# iterate. Realistic add: 2,414 BSE-only actives, of which ~1,643 are X/XT
# permitted-tier; the commercially interesting slice is ~100 A/B/T names plus
# ~509 SME. See MONEY-1292.
#
# Also: history floors at 2018 (pre-2018 index records are stubs), and the
# 3Y/5Y CAGR columns stay null until the backfill has laid down 4 and 6 fiscal
# years respectively.
#
# TWO ARM FLAGS, ONE PER JOB — MONEY-1286. `XBRL_PROJECTION_APPLY` arms the
# StockFinancials projection; `XBRL_RATIOS_APPLY` arms the StockRatios
# derivation. They were ONE flag until both gates were run against prod on
# 2026-08-30 and DISAGREED:
#
#   xbrlratios prod   PASS       roe READY 666/697 (95.6%), nothing BLOCKED
#   xbrlrecon  prod   NOT READY  totalLiabilities 17.2% disagreement,
#                                totalAssets/totalEquity 6.9%, netIncome 5.9%,
#                                against a 5.0% floor
#
# The state the evidence supports — ratios ON, financials OFF — could not be
# expressed with one switch: arming what passed would have armed what failed,
# through a one-way door. Neither flag narrows or arms the other's job.
XBRL_PROJECTION_APPLY=        # "true" ARMS the PROJECTION (stock_financials).
                              # Ships PRESENT and "false" in both cloudbuild
                              # specs — absent and "false" must not be the same
                              # state, because "absent" is exactly how
                              # MF_METADATA_PROVIDER disabled its job silently
                              # for months (MONEY-1214). Compared against the
                              # literal string, never Boolean(): Boolean("false")
                              # is true, which would arm the job in the one
                              # configuration meant to keep it off. Read PER
                              # CALL, never a module-scope const — a module-level
                              # read freezes at import, and on a warm Cloud Run
                              # container that turns a redeployed switch into no
                              # switch at all.
                              #
                              # PRECONDITION for flipping it: the F3 reconcile
                              # (scripts/data/xbrl-reconcile.ts) reading READY.
                              # It does NOT, as of 2026-08-30 (the four
                              # disagreements above). StockFinancials has no
                              # `source` in its unique key, so the FIRST XBRL
                              # write for a period destroys the value it
                              # replaced — there is nothing left to compare
                              # against afterwards.
                              # A message may narrow this to false for one run;
                              # it can never arm one.
XBRL_RATIOS_APPLY=            # "true" ARMS the RATIOS job (stock_ratios). Same
                              # literal comparison, same per-call read, same
                              # present-and-"false" discipline in both specs.
                              # Ships "false" in BOTH today; prod flips as a
                              # deliberate deploy once MONEY-1288 widens the
                              # gate.
                              #
                              # PRECONDITION: the ratios gate
                              # (scripts/data/xbrl-ratios-validate.ts, judged by
                              # packages/core/src/market-data/xbrl-ratios-gate.ts)
                              # reading PASS.
                              #
                              # IT DOES NOT, as of 2026-09-14. This line read
                              # "It DOES, on prod 2026-08-30" for two tickets,
                              # and the gate that said so was grading the wrong
                              # question. The current verdict is
                              #
                              #   NOT ready. BLOCKED: roe, roce.
                              #
                              # `roe` JOINED THE BLOCKED LIST ON 2026-09-14, and
                              # it is the whole argument for the writable-cohort
                              # rung. Measured on prod that day:
                              #
                              #   roe   graded   763/796  95.9%  -> would PASS
                              #         WRITABLE  64/69   92.8%  -> BLOCKS
                              #
                              # The gate reads `>= 95%`, so on the population it
                              # used to grade, `roe` cleared the bar. On the
                              # symbols the writer can ACTUALLY REACH it does
                              # not. A ratio can agree across a cohort arming
                              # would never write and disagree on every row that
                              # actually gets stored — through a ONE-WAY DOOR,
                              # with no vendor row left afterwards to notice.
                              # The two blocking symbols are CENTUM and DVL, both
                              # the attributable-vs-profitForPeriod ambiguity at
                              # xbrl-projection.ts:1069, which decides the SIGN
                              # of every return ratio.
                              #
                              # `roce` blocks on both populations — 35.0% graded,
                              # 33.1% writable, 49 sign mismatches.
                              #
                              # WHAT CHANGED IS THE QUESTION, NOT THE DATA. The
                              # old gate compared VALUES where both sides had
                              # one and called that agreement. It never asked
                              # how OFTEN we produce a value at all, so a ratio
                              # we fill for fewer symbols than the vendor could
                              # pass while quietly shrinking the column.
                              # MONEY-1401 added a FILL rung for that, and
                              # `FILL_BLOCKING_RATIOS` is roe, roce, netMargin
                              # — the three a screener actually sorts on.
                              #
                              # THAT RUNG THEN GRADED THE WRONG POPULATION, and
                              # its first two verdicts were BOTH false. It
                              # counted what `deriveRatios` COULD produce,
                              # joined on the FILING's exchange; the writer keys
                              # on the INSTRUMENT's and refuses a mismatch. At
                              # symbol level, measured 2026-09-14, only 183 of
                              # 2,468 graded symbols sit on an instrument the
                              # writer can reach, and 179 survive the writer's
                              # own refusals (4 stale ANNUAL). That is the FILL
                              # census population.
                              #
                              # THE FIX IS TAG-AND-RATE, NOT FILTER. An earlier
                              # pass wired `writerReachable` into the FILL census
                              # only — three lines, none of them in the grading
                              # loop — so every input to the agreement ladder,
                              # which is the ONLY thing that sets `pass`, was
                              # still the wide population. Every graded row now
                              # carries `writable` and the writable cohort is
                              # rated a SECOND time. That rating is STRICT-ONLY:
                              # it can upgrade a verdict to BLOCKED and can never
                              # rescue one, which is the only safe polarity on a
                              # one-way door.
                              #
                              #   roe    graded 763/796 95.9% -> WRITABLE 64/69
                              #          92.8% -> BLOCKS (it did not before)
                              #   roce   graded 596/1703 35.0% -> WRITABLE
                              #          44/133 33.1% -> blocks either way
                              #
                              # So `roe` and `roce` were both blocked by rows no
                              # armed run would ever have touched. `roce` still
                              # blocks — on 49 SIGN MISMATCHES, an agreement
                              # rung and a real disagreement about the data.
                              # The run still fails; it fails for the right
                              # reason now.
                              #
                              # READ THE CENSUS, NOT JUST THE VERDICT. 183 of
                              # 2,468 symbols is a small population to arm a
                              # one-way door on, and it is small because
                              # `scripts/data/reresolve-xbrl-instruments.ts` has
                              # not been run — it takes the writable cohort to
                              # ~2,000. The gate prints the census every run,
                              # warns when the writable set is under half the
                              # graded one, and refuses outright below
                              # `FILL_MIN_POPULATION` (50) — because two counts
                              # compared with `>=` make an EMPTY population read
                              # OK for ever, which is the same not-measured-is-
                              # not-passed defect the identity rung had.
                              #
                              # AND THE TIE-BREAK CANNOT SETTLE IT. The vendor
                              # is frozen and dead, so MONEY-1397 added a
                              # third source: our own PDF extraction
                              # (scripts/data/xbrl-vs-pdf-ratios.ts). It
                              # returned the SECOND verdict rather than the
                              # first — our two parses agree on only 72% / 68%,
                              # and where they differ the PDF side is the wrong
                              # one: BELRISE roe reads 13.101 from XBRL against
                              # 1.310 from the PDF, exactly 10x, which is a
                              # scale fault in the extractor and not a dispute
                              # about the company. `roce` was not declared a
                              # divergence at all — n=15 is too few to call.
                              # So the PDF lane needs its own fix before it can
                              # arbitrate anything.
                              #
                              # SNAPSHOT FIRST, WHATEVER THE VERDICT.
                              # scripts/data/snapshot-vendor-fundamentals.ts
                              # copies the 2,135 incumbent vendor rows before
                              # any arming run. The door below is one-way and
                              # the gate needs the vendor side to grade
                              # against; without a snapshot the FIRST armed
                              # night destroys the only evidence any future
                              # gate could use, in that environment, for good.
                              #
                              # THE PRIZE, measured. `stock_ratios` holds 2,135
                              # rows, ALL vendor (TICKERTAPE), frozen since
                              # 2026-03-21. TEN of the 26 XBRL-owned columns are
                              # 100% NULL platform-wide — operatingMargin,
                              # grossMargin, ebitdaMargin, assetTurnover,
                              # earningsGrowth, revenueGrowth3Y/5Y,
                              # earningsGrowth3Y/5Y, pegRatio, returnBasis — and
                              # nine more sit near 4% (netMargin 86 rows,
                              # debtToEquity 86, currentRatio 86). From the
                              # 108,020 filings already ingested, per-symbol
                              # derivable TODAY: netMargin/operatingMargin 2,466
                              # symbols, grossMargin 2,426, ebitdaMargin 2,417,
                              # roe/roa/assetTurnover 2,303, debtToEquity 2,292,
                              # roce 2,287, currentRatio 2,109.
                              #
                              # SAME ONE-WAY DOOR on its own table: StockRatios
                              # is @@unique([symbol, exchange]) with no `source`
                              # in the key, so the first XBRL write replaces the
                              # vendor row and the gate can never again produce
                              # arming evidence in that environment. The write
                              # is a PARTIAL update (only columns the plan
                              # filled), so targetPrice/recommendation survive.

# Broker APIs (for each broker)
# MONEY-837 — Zerodha two-app model:
#   ZERODHA_API_KEY/SECRET point at the FREE "Personal" Kite app (multi-user
#   access enabled) and power PORTFOLIO SYNC (Profile, Holdings+MF, Positions,
#   Order book, Tradebook) in apps/web + workers. The Personal tier has NO live
#   quotes / charts / WebSockets, so apps/web runtime market data is Yahoo-only.
#
#   MONEY-1379 — BROKER SYNC IS ZERODHA-ONLY, BOTH CONNECTORS, as of
#   2026-09-11 (founder decision). `SYNC_ENABLED_BROKERS` in
#   packages/services/src/broker-sync.service.ts is the one place, and
#   broker-sync.test.ts pins its membership by VALUE so widening it has to be a
#   deliberate edit that fails a test first. It applies ONLY when the caller
#   names no broker, so it narrows the SCHEDULED fan-out and nothing a user
#   asked for — measured, not assumed: both user-triggered publishers pass a
#   concrete broker (apps/web/.../broker-connection.ts:1473 and
#   apps/api/src/routes/v1/brokers.ts:344).
#
#   ZERODHA_CONNECT is in the set because the rule names both connectors, and it
#   is harmless: `classifyConnectionForSync` skips it one layer down with the
#   named reason `connect-token-only`. Filtering it at the QUERY instead would
#   make that reason unreachable — a Connect token that exists would become
#   invisible rather than explained.
#
#   AN EMPTY SHARD IS NOT AN ERROR. The scheduled sync fans out to 64 buckets
#   and prod holds 9 connections across 6 of them, so 58 leaves of every
#   fan-out match nothing. That used to throw "No broker connections found" ->
#   500 -> five Pub/Sub redeliveries -> dead letter -> an in-app notification:
#   3,733 5xx and 928 dead-letters a DAY, 97.6% of that subscription, for work
#   that did not need doing. `isScheduledShard` now distinguishes a shard from a
#   user, and it is `Number.isInteger` rather than truthiness because bucket 0
#   is a real shard.
#
#   AND THE HISTORICAL LEG IS SHARDED TOO. `syncHistoricalTradebook` had no
#   `syncBucket` field at all, so a leaf reached it with userId "*" and no
#   bucket and backfilled EVERY connection on the platform — 6x today, 64x at
#   scale. Invisible only because the day-sync's throw aborted the leaf first on
#   the empty shards, so fixing that throw alone would have converted one into
#   the other.
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
#
#   MONEY-1298 — THE REAL INDIAN CASH-EQUITY UNIVERSE IS 5,610 SYMBOLS.
#   Measured on prod 2026-08-30: 8,083 ISIN-bearing active rows (3,184 NSE +
#   4,899 BSE) collapsing to 5,610 distinct symbols and 5,615 distinct ISINs,
#   against 20,850 rows typed `EQUITY`. So ~61% of the "equity" table was never
#   equity, and three consequences all read as different bugs: ISIN coverage
#   reports "8,083 of 20,850" and looks like a broken enricher when it is 100%
#   of the real set; sector enrichment spends its weekly 500-row batch on bonds
#   and stamps them permanently `N/A`; and `captureRenames`
#   (instrument-sync.ts) filters `isin: {not: null}`, so a null-ISIN row is
#   excluded from rename detection and a rename orphans its price history.
#
#   The cause is the paragraph above: Kite stamps `series` "EQ" for every cash
#   instrument, so `classifyCashInstrument` — which reads only that column —
#   honestly abstained on 12,541 rows. The fix is NOT a looser series rule. It
#   is three MORE signals, each SUPPLIED BY THE FEED rather than inferred from
#   the string, and each still gated on the stamped default so a sourced value
#   always wins:
#
#     segment "INDICES"          213 -> INDEX  Kite naming an index outright.
#                                              NSE 136 + BSE 77. Ordered FIRST,
#                                              ahead of the ETF name matcher:
#                                              a fund is named after the index
#                                              it tracks, so the segment is the
#                                              only thing separating "NIFTY 50"
#                                              from "JIOBLACKROCK NIFTY 50 ETF".
#     NSE `-XX` symbol suffix  7,149 -> DEBT 6,172 · EQUITY 876 · INVIT 21 ·
#                                       REIT 6 · UNKNOWN 72.
#                                              NSE lists a non-main-board
#                                              instrument as <BASE>-<SERIES> and
#                                              `extractBaseSymbol` returns the
#                                              trading symbol UNCHANGED for
#                                              NSE/BSE — so the exchange's own
#                                              series is sitting in `symbol`
#                                              (664UP30-SG, 667GS2050-GS,
#                                              965SCL25C-N0). Recovered and fed
#                                              to the SAME tables, so a new NSE
#                                              debt series added to bhavcopy.ts
#                                              is covered automatically and the
#                                              EQUITY series come back EQUITY.
#     BSE stamped default,
#     no ISIN, name===symbol   5,392 -> DEBT 5,288 · ABSTAIN 104.
#                                              BSE's scrip master covers the
#                                              whole active universe in ONE run,
#                                              so a row it never matched is not
#                                              in the BSE cash-equity universe;
#                                              and Kite supplying the CODE as
#                                              the `name` is the positive signal
#                                              that it is a bond/CP row.
#
#   TWO RULES WERE REJECTED ON MEASUREMENT, and both would have deleted real
#   companies from the screener — a false DEBT verdict clears sector/industry
#   and the enrichment pipeline queries `instrumentType: "EQUITY"` only, so
#   there is no path back:
#     - "no ISIN -> not equity". AUGMONT ENTERPRISES is a real, newly-listed NSE
#       company with no ISIN yet. Absence of an ISIN is a NECESSARY GATE on
#       every rule above, never a sufficient signal.
#     - "BSE group EQ + no ISIN -> DEBT" (the shape MONEY-1302 proposed from the
#       30 NHAI tax-free bonds). That population also holds ~45 real companies
#       (TEMPSENS INSTRUMENTS, NOVYRA PHARMACHEM, BENARA BEARINGS, GLOBAL
#       DEFENCE INDUSTRIES), ~45 exchange-listed MF plans and ~55 BSE index
#       rows. Hence the `name === symbol` test.
#
#   `INDEX` is NOT a new instrumentType — it is in the schema comment,
#   INSTRUMENT_TYPE_MAP (Kite `IF`), quote-service's QUOTABLE_TYPES and
#   discover-indices. Prod holds ZERO INDEX rows today, so `getIndices` returns
#   an empty list; this is the one retype that ADDS a surface.
#
#   DO NOT DEACTIVATE THE 870 NSE SUFFIXED TWINS (`SYM-SM`/`-BE`/`-ST`/`-BZ`
#   beside a bare ISIN-bearing `SYM`). They look like duplicates worth tidying.
#   446 of them carry 13,917 `daily_prices` rows, 455 `latest_quotes` and 31
#   `stock_news` on the SUFFIXED `_id`, and `DailyPrice.instrumentId` is a
#   REQUIRED relation — a dangling reference THROWS and blanks every result.
#   Prices landed on BOTH rows (all 851 bare rows have history too). The
#   classifier types both EQUITY and nothing retypes them; consolidating them is
#   a separate ticket that has to move the price rows first.
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
# Indian mutual funds — AMFI + the AMC disclosures (MONEY-1403/1404/1405)
#
# THREE FEEDS, AND EACH ONE FAILED SILENTLY AT LEAST ONCE. The pattern is the
# same every time and it is the reason this section exists: a parser that
# cannot read its input returns an EMPTY RESULT, the job reports success, and
# nothing in any counter separates "the feed changed" from "there was nothing
# today".
#
# ── NAVAll: the grammar changed under a positional parser ───────────────────
#
# `portal.amfiindia.com/spages/NAVAll.txt` is the whole-industry NAV file and
# the backbone of every MF surface we have. Around 2026-08-19 AMFI inserted
# `Plan;Option` BETWEEN `Scheme Name` and `Net Asset Value` — 6 columns to 8.
# Every positional reader then took `parts[4]` as the NAV, read the literal
# string `"Direct Plan"`, produced NaN, and skipped the row. All of them. For
# 26 nights `mf-sync` parsed ZERO funds and exited 0.
#
# It is parsed BY HEADER NAME now (`parseNavAllHeader` in
# `amfi-scheme-bridge.ts`), there is ONE copy of that parser, and an
# unrecognised header is a DISTINCT state that THROWS
# (`AmfiNavGrammarError`) rather than returning `[]`. `syncAmfiMutualFunds`
# also throws on zero funds: a whole-industry feed that yields nothing is never
# a quiet day.
#
# AND THERE IS NO POSITIONAL FALLBACK ANY MORE. There was one — a fixed
# six-column layout used whenever the header was absent or unrecognised — and
# it was MONEY-1403 rebuilt as a safety net. It was reachable on every real
# input: the guard that was meant to refuse a headerless file read
# `!sawColumnHeader && sections.length === 0`, and the live feed carries dozens
# of section lines (`Open Ended Schemes(Equity Scheme - Large Cap Fund)`), so
# that conjunction was false every time. Measured on the shape that matters — a
# SIX-wide body whose header names the columns in a different ORDER, spelled so
# the detector misses it — the fallback read field 0 as the scheme code while
# the header said field 0 was the date, and reported success. A row is now
# refused outright when no layout was stated by the FILE.
#
# ONE STRAY SPACE USED TO KILL THE WHOLE FEED. The header cell
# `ISIN Div Payout/ ISIN Growth` is the one AMFI is visibly careless with, and
# the alias list carried two hand-typed spellings of it. A third — a space
# BEFORE the slash as well as after — matched neither, so `parseNavAllHeader`
# returned null, which means `AmfiNavGrammarError`, which means `mf-sync`
# throws and no NAV lands. `normaliseHeaderCell` now collapses whitespace
# around a slash, so one alias covers every spacing and the list cannot drift
# out of step with the file again. A stray space is not a grammar change and
# must not be answered like one.
#
# The lesson generalises past this file. A sibling job had ALREADY logged
# `NAVAll UNRECOGNISED — the feed grammar changed` and it was discounted in
# favour of this repo's famous Tickertape-blocks-our-egress pattern. One
# `head -1` of the file settled it. Believe the specific log over the
# pattern-match.
#
# THE FEED IS ARCHIVED NOW, dated: `feeds/AMFI/navall/{YYYY}/{MM}/`.
# `basename` is passed EXPLICITLY because the URL's own basename is the
# constant `NAVAll.txt`, so a dated descriptor without it collapses a whole
# month onto one key. Its shape guard (`AMFI/navall` in `feed-payload.ts`)
# pins TWO header cells of the eight — `Scheme Code` and `Net Asset Value` —
# chosen because they BRACKET the inserted columns and have survived every
# revision. Pinning the full header would make the next legitimate insertion
# reject the feed outright, which is this section's own bug rebuilt as a guard.
#
# THE COMPLETENESS GATE, AND THE ARITHMETIC THAT LOOKS LIKE IT AND IS NOT.
# `mf-sync` now refuses a PARTIAL night: if more than `MF_SYNC_MAX_MISSING_PCT`
# (2%) of ACTIVE masters go un-priced it reports and throws, because
# `parsed=7000, upserted=7000, failed=0` is a clean-looking success and half
# the platform's NAVs. Measured live 2026-09-13 — NAVAll lists 14,361 codes and
# prices 14,120; of our 14,225 active masters, 199 are absent from the file and
# ZERO are present-but-unpriced, so a good night projects to 1.399% against the
# 2% wall.
#
# The 241 codes AMFI lists at nav <= 0 are NOT part of that number, and the
# ratio that says they are is the trap: `241 / 14,361` is 1.678% and reads like
# most of the headroom is gone, but it divides FEED codes by FEED codes while
# the gate divides MASTERS by MASTERS. The intersection is empty. Re-measure
# before touching the constant, and when it starts firing on healthy nights the
# fix is a deactivation rule for schemes AMFI has dropped — nothing in this
# codebase ever sets `isActive: false`, so that 199 is a floor that only grows.
#
# QA does NOT replay this feed. `mf-sync-daily` is PROD_ONLY and
# `mutual_fund_masters` is a REFERENCE_COLLECTION, so QA receives ROWS. The
# archive's value here is the historical copy MONEY-1403 did not have, plus
# making the fetch visible to `no-feed-fetch-bypass.test.ts`.
#
# ── The AMC portfolio workbooks: five traps, four measured the hard way ─────
#
# SEBI-mandated monthly holdings, one workbook per AMC (or per scheme), and no
# two houses publish the same shape. Everything below cost a house its entire
# history before it was found:
#
#   1. AN OVER-ANCHORED HEADER REGEX DROPS A WHOLE HOUSE, SILENTLY.
#      `findHeaderRow` locates the holdings table by requiring an ISIN cell AND
#      a percent cell in one row. `/^isin$/` missed Tata's `ISIN CODE`;
#      `/^%\s*to\s*…/` missed 360 ONE's `Rounded % to Net Assets`. Both houses
#      were `provenance: "verified"`, both downloaded a real workbook every
#      month (1,762,746 B / 71 sheets and 283,616 B / 12 sheets), both parsed to
#      ZERO, and both reported `FETCH_FAILED` — a status naming the one
#      subsystem that was working. The rules are word-bounded and
#      qualifier-tolerant now, and NOT bare substrings: `revising` and `raising`
#      both contain `isin`, and these sheets are full of footnote prose.
#   2. A PERIOD NEED NOT BE A DATE, OR SAY "AS ON". Zerodha states it as
#      `MONTHLY PORTFOLIO STATEMENT … FOR AUGUST 2026` — different preposition,
#      no day. `extractAsOnDate` runs a PRECISE pass over every scanned row
#      before it will accept a bare month, because these files routinely put the
#      PUBLICATION month in a title and the DATA month in the as-on line, and a
#      single ordered scan takes whichever is higher up the sheet.
#   3. THE EXTENSION LIES, IN BOTH DIRECTIONS. Nippon's `.xls` is OOXML; ABSL's
#      INNER `.xls` is genuine OLE2. Only magic bytes decide. `XLSX.read` also
#      HANGS FOREVER, never throwing, on a truncated zip — hence the
#      end-of-central-directory check before the parse.
#   4. A ZIP MEMBER MAY DEFER ITS OWN SIZE. ICICI's 147-member archive sets
#      general-purpose bit 3 on every member, so the LOCAL headers carry
#      `compressedSize: 0`; a forward scan truncates member 1 and 37 ordinary
#      workbooks sniff as `zip-archive`. Read the CENTRAL DIRECTORY, keep the
#      local walk only as the truncated-file fallback.
#   5. A MERGED HEADER CELL EMPTIES A COLUMN. Kotak merges `Name of Instrument`
#      across A:C and SheetJS reports the value only at the top-left cell —
#      119 sheets, 110 holdings, every ISIN null, one cash line per fund. ICICI
#      prints each SEBI section's subtotal ON the heading line, which sums a
#      sheet to ~300%.
#
# NONE OF THESE PRODUCE AN ERROR. Every one produces a workbook that parses
# "successfully" and is wrong, which is why the sheet gate now refuses on the
# file's OWN as-on date (`STALE_FILE` / `NO_AS_ON` / `SCALE_SUSPECT` are three
# distinct refusals, never one "skipped") and why a per-AMC row count is not
# evidence that an AMC parses.
#
# COVERAGE IS MEASURED AGAINST AMFI'S OWN REGISTRY, not against our table.
# `amfi-amc-registry.ts` reads AMFI's portfolio-disclosure page (57 AMCs, 52
# publishing a monthly link, 48 of those answering 200) and `resolverCoverage`
# joins it on `amfiMfId`: 17 resolved as of 2026-09-13. `mf-portfolio-sync`
# logs that nightly and NAMES the remainder; `scripts/data/amc-disclosure-registry.ts`
# is the operator's triage view. NEITHER promotes a link to a source — 51 of
# the 52 are landing pages, and a guessed URL 404s identically to "not
# published yet", so `provenance` stays something a human sets after fetching
# the current month and opening the file.
#
# `etf-expense-enrichment` IS RETIRED (MONEY-1404) and was a GUARANTEED no-op
# in every environment rather than a job whose upstream died:
# `fetchKuveraMetadata` returns null unless `MF_METADATA_PROVIDER === "kuvera"`
# and both specs set `"amfi"`, so it could never reach a source that 404s every
# ISIN anyway. `expenseRatio` comes from AMFI's own monthly TER file via
# `mf-metadata-weekly` (63.5% coverage, measured 2026-08-18, against that job's
# zero). Its ROUTE survives to answer 200 and DROP the message, because Pub/Sub
# ACKs only on 2xx; its topic is out of all three provisioning lists.

# US price backbone — Tiingo (MONEY-980)
#
# WHERE US PRICES COME FROM: our own `candles` warehouse, never Tiingo at
# request time. `CandleRepository` merges a Mongo hot window with gzipped-JSONL
# cold shards on GCS (`candles/{market}/{timeframe}/{symbol}/{year}`, no file
# extension — the format is behind the seam and is sniffed from magic bytes, so
# a later parquet writer reuses the same keys). India's `DailyPrice` /
# `IntradayBar` are untouched: MONEY-1043 is decided as COEXISTENCE.
#
# NOTHING outside `market-data/tiingo/**`, the backfill script and `us-eod-sync`
# may import the Tiingo client — consumers read `CandleRepository`, so a future
# feed is one new `source` value plus one sync job. `api.tiingo.com`,
# `apimedia.tiingo.com` and `www.sec.gov` are in `FEED_HOSTS`, so a raw fetch()
# at any of them fails `no-feed-fetch-bypass.test.ts` by file and line.
#
# THREE MEASURED FACTS that the code depends on and the docs get wrong:
#
#   1. The EOD CSV column order is NOT the documented one. Live header is
#      `date,close,high,low,open,…` — close SECOND, open FIFTH. A positional
#      parser written from the docs silently SWAPS open and close, producing
#      plausible bars and a wrong candle for every US security. Parse by header
#      NAME. Pinned by `tiingo-logic.test.ts`.
#   2. A TICKER IS NOT A SECURITY. The master holds two rows for `DOW` on NYSE
#      — Dow Chemical 1972-2017 and Dow Inc. 2019- — identical in exchange,
#      assetType and currency. 2,196 tickers repeat, 928 across venues, 834
#      delisted rows share a ticker with a live one. Tiingo serves only the
#      CURRENT occupant (asked for DOW since 1962, it returns 2019 onward), and
#      `permaTicker` is NOT enabled on our token. So every candle carries a
#      `listingId` (`{symbol}:{exchange}:{listingStartDate}`) and reads resolve
#      to ONE listing — a full-range read must never concatenate two companies.
#   4. A MASTER WINDOW DATES THE SECURITY, NOT ITS TENURE ON THE TICKER
#      (MONEY-1616). Barrick's `B` row starts 1985 and overlaps Barnes Group's
#      `B`; 437 master pairs overlap. The lake replay admits such a session as
#      `LATEST_OCCUPANT` only for the symbol's UNIQUE latest-ending window, and
#      withholds the whole symbol on stitching (the occupant's id before its own
#      start, or a >28% adjacent-session seam at another window's boundary —
#      BTDR's 2023-04-13 bar at $10 is the SPAC's). The residual it cannot see is
#      a price-continuous seam: <=85 rows. Filter
#      `resolution_method != 'LATEST_OCCUPANT'` for strict work.
#      Its first signal (the occupant's id BEFORE its own start) is
#      HISTORICAL-ONLY once MONEY-1617's clip and relabel file those bars under
#      the predecessor; for anything written after that, the >28% seam is the
#      live guard.
#   5. THE WRITERS FILE A BAR UNDER THE WINDOW COVERING ITS SESSION (MONEY-1617),
#      never under the listing they fetched (`clipBarsToListingWindows`,
#      `us-eod-sync` + `tiingo-us-backfill`); an uncovered bar is dropped and
#      counted. Where several windows cover a session the fetched listing keeps
#      the bar only if it is ACTIVE or the symbol's unique latest occupant
#      (`latestOccupantOf`, twinned with the lake gate's copy and pinned by an
#      agreement test) — a DELISTED fetch of `B` returns Barrick's series.
#      counted. ACTIVE windows are open-ended. A PHANTOM (<=5 days, overlapping a
#      longer same-venue window) loses every tie in the SHARED
#      `resolveListingForDate`, and is reported, never deleted. A Tiingo master
#      split does not re-key bars already written: run
#      `scripts/data/relabel-us-candles.ts`. A hot-only relabel does not move the
#      lake source hash and `lake-replay-us` has no force flag, so run the
#      relabel BEFORE a parser-version reload (`price-bar-v2`), which picks it up.
#   3. 403 MEANS TWO DIFFERENT THINGS. A bad token returns 403 with
#      `{"detail":"Invalid token."}`; an unentitled endpoint returns 403 with
#      ZERO bytes. 429 is undocumented and untriggered. Classify on body shape,
#      never on status alone.
#
# The dedicated corporate-actions endpoints were beta-gated; BETA ACCESS IS NOW
# GRANTED and all five answer 200 (re-probed 2026-08-28). Leg (c) nevertheless
# STAYS on the derived path — dividends and splits read off the `divCash` /
# `splitFactor` columns that ride along on the EOD response — for a reason that
# only measuring revealed:
#
#   `splitStatus` DOES NOT EXIST in the live response. The docs list it ("a"
#   active / "c" cancelled) and it was the entire argument for switching, since
#   a cancelled split applied as real mis-adjusts a whole series. Measured
#   across 54 split rows from five ex-dates, the key union is exactly
#   {exDate, permaTicker, splitFactor, splitFrom, splitTo, ticker}. The endpoint
#   carries no cancellation signal either, so switching would buy nothing for
#   adjustment and cost extra requests.
#
#   `permaTicker` CANNOT replace `listingId`. It is real, and prices ARE
#   queryable by it, but it is absent from metadata and from the master, and
#   `/tiingo/daily/<permaTicker>` 404s — so it is obtainable only from a
#   corporate-actions row, which exists only for securities that have had one.
#   `DOW` and `BRKL` both return ZERO split rows, so no permaTicker exists for
#   the two recycled tickers the whole design was built around.
#
# What the endpoints DO add is information not present in a price bar at all:
# dividend `paymentDate` / `recordDate` / `declarationDate` /
# `distributionFrequency`, and split `splitFrom` / `splitTo`. That is the
# "Dividend tracking" roadmap item as a NEW capability, tracked in MONEY-1262 —
# not a replacement for anything here.
#
# Adjustment is computed at READ time (CRSP, cumulative factors back from the
# latest bar), so a new corporate action invalidates a cache instead of
# restating history — AAPL alone is 11,517 rows. Verified against Tiingo's own
# `adjClose` across that full series: worst error 0.023%, zero bars off by more
# than 0.1%.
#
# Known limits, written down rather than discovered later: history floors at
# 1962; `ENE` (Enron) 404s and `LEH` (Lehman) returns an EMPTY series, so
# "delisted" coverage is partial and Tiingo says so ("tickers that have not yet
# been recycled"); the master carries CNY/HKD/AUD listings, so scope filters on
# `priceCurrency === "USD"` as well as exchange. Measured: 74,217 in-scope rows
# collapse to 72,685 primary listings — 15,629 equities, 7,642 ETFs and 49,414
# mutual funds (41,371 active / 31,314 delisted) AS OF THAT MEASUREMENT. Re-
# measured 2026-08-30 the master holds 74,134 rows — 41,352 active / 32,782
# delisted (MF 27,289/22,557, Stock 8,307/8,100, ETF 5,756/2,125). The universe
# GREW; neither figure is wrong, so both carry their date rather than one
# quietly overwriting the other.
#
# THE permaTicker ENRICHER IS ACTIVE-ONLY BY DESIGN, so a DELISTED listing
# never gets one. A documented coverage FLOOR, not a bug and not a backlog that
# converges. `permaTicker` has exactly one writer,
# `enrichUsInstrumentsWithPermaTicker`, whose page is
# `where: { listingStatus: "ACTIVE" }` (`tiingo-search.ts:197`/`:211`), and the
# filter cannot simply be widened: Tiingo's search resolves the CURRENT occupant
# of a ticker, so a delisted predecessor would be handed its SUCCESSOR's
# permaTicker — another company's dividends and splits on our join key,
# silently, which is finding 2 above from the other side. Measured 2026-08-30:
#
#   22,556 delisted mutual funds
#    8,100 delisted stocks
#    2,125 delisted ETFs
#
# What that costs differs by asset class, and the difference is the whole point
# of having TWO keys. `Candle` keys on `listingId`
# (`{symbol}:{exchange}:{listingStartDate}`), which is derivable from the master
# for every row — so the 8,100 stocks and 2,125 ETFs ARE reachable, through the
# BACKFILL (`scripts/jobs/tiingo-us-backfill.ts --only-delisted`), just never
# through the nightly legs, which narrow to ACTIVE in `buildUsEodWhere`.
# `UsFundNav` keys on `(permaTicker, date)`, which is NOT derivable — so the
# 22,556 delisted funds will NEVER receive a NAV row, from the nightly job or
# the backfill (it checkpoints them `NO_PERMATICKER` and moves on). Subject to
# `LEH`-style upstream gaps on top of that.
#
# So do not read a low `us_fund_nav` coverage ratio against the whole
# 49,846-fund master as a defect: the reachable denominator is the ACTIVE
# partition, and the nightly job no longer spends a billed request discovering
# that per fund (MONEY-1291 — it skips before the fetch, not after).
#
# MUTUAL FUNDS ARE IN SCOPE, on the NMFQS venue, and that is load-bearing rather
# than generous: the nightly job has a NAV leg, and a leg whose population is
# empty by construction selects nothing, writes nothing and reports HEALTHY
# forever. A fund's OHLC fields carry its NAV.
#
# SCHEDULING FOLLOWS THE US CLOCK, not ours. Fund NAVs publish after 12:00 AM ET
# = 10:30 IST under EST, which is LATER than the 8:00 PM ET equity correction
# window (06:30 IST). The nightly job therefore runs 11:00 IST, gated by the
# later of the two boundaries — an earlier run fetches an empty NAV set every
# night without failing. Crons are Tue-Sat IST because a US session closes
# 4:00 PM ET, which lands after midnight IST the following day.
#
#   10:00 IST  us-instrument-master-sync   prod
#   11:00 IST  us-eod-sync                 prod  (PROD_ONLY)
#   14:00 IST  us-instrument-master-sync   qa
#
# QA DOES NOT RUN THE PRICE JOB, and that differs from India on purpose.
# `bhavcopy-sync` runs in BOTH envs replaying prod's archived bytes, because
# `DailyPrice` keys on `instrumentId` and QA holds its own instrument _ids — the
# rows are not portable, so QA has to re-INGEST rather than receive. `Candle`
# deliberately keys on (symbol, exchange, timeframe, ts) and carries NO ObjectId
# reference, so it IS portable: `us-eod-sync-daily` is in PROD_ONLY_JOBS and
# `candles` + `fx_rates` are in REFERENCE_COLLECTIONS, so QA receives exactly
# what prod computed.
#
# That is strictly safer than the replay arrangement here, because Tiingo is a
# PAID METERED api and a replay MISS is a soft failure by design: any drift in
# the mirror timing would silently spend a second full copy of the quota (~73k
# requests) instead of degrading. Copying rows removes that failure mode rather
# than scheduling around it.
#
# The MASTER still runs in both envs, because `instrument_mappings` is QA-DIRECT
# and cannot be synced down. That costs nothing: `supported_tickers.zip` is a
# PUBLIC file (verified 200 with no Authorization header) archived UNDATED under
# `current/`, so it never races a mirror and spends no quota.
TIINGO_API_KEY=               # GCP Secret Manager: TIINGO_API_KEY_QA / _PROD.
                              # Auth header is `Authorization: Token <key>` —
                              # the scheme word is "Token", not "Bearer".
TIINGO_PLAN=                  # Which plan's ceilings to obey. The ONE switch.
                              #   COMMERCIAL     20k/hr, 150k/day, 100 GB/mo
                              #   REDISTRIBUTION 80k/hr, 1.2M/day, 1 TB/mo
                              # UNSET or unrecognised resolves to COMMERCIAL,
                              # the LOWER pair, deliberately: guessing high
                              # walks the backfill into a 429 wall mid-universe
                              # and leaves a half-filled table, while guessing
                              # low only runs slower. Resolved PER CALL, never
                              # captured in a module const (a module-scope read
                              # freezes at import — the bug documented on
                              # bse-client.ts's retry config).
                              #
                              # WE ARE ON COMMERCIAL TODAY, whose licence is
                              # INTERNAL USE ONLY. Ingest and storage are fine;
                              # DISPLAYING US prices to users is a
                              # redistribution act and needs the $250/mo
                              # "EOD + IEX Redistribution" plan. That upgrade is
                              # MONEY-1262 — it unblocks the LICENCE, not the
                              # throughput: the whole backfill is ~73k requests
                              # (one per symbol; a single call returns a
                              # symbol's entire history) and ~10 GB, which fits
                              # inside EITHER plan — 3.7h at Commercial's
                              # 20k/hour, under an hour on redistribution.
                              #
                              # Tiingo publishes no quota headers, so a 429 is
                              # the only feedback and it arrives too late to
                              # steer by. The client paces PROACTIVELY at
                              # 3600s/perHour between requests (180ms on
                              # Commercial) rather than bursting.

# US REALTIME — Tiingo equity-intraday websocket + news poller (MONEY-1309)
#
# THE FEED IS THE 24x5 CONSOLIDATED VENUE, NOT IEX. Tiingo's own doc page for
# this endpoint recommends IEX; that line is SUPERSEDED for our account. Rishi
# Singh (Tiingo CEO), by email 2026-08-31: "Use the 24x5 plan - it will be the
# successor to IEX ... whereas IEX derived is 1 venue, this new 24x5 venue is 4
# venues ... we're including it no additional cost." There is deliberately NO
# feed-selection env var and NO IEX code path — a config value nobody should
# choose is an invitation to choose it. The email is quoted in the header of
# `tiingo-realtime-logic.ts`, next to the endpoint constant, because without it
# the next reader migrates us back on the strength of the stale doc page.
#
# ENTITLEMENT, probed live 2026-08-31 against TIINGO_API_KEY_PROD:
#   WS   wss://api.tiingo.com/equity/intraday  (thresholdLevel 4 and 6)  200 OK
#   REST /tiingo/equity/intraday/?tickers=...  200  <- TRAILING SLASH REQUIRED;
#        without it the endpoint 301s and fetch drops the Authorization header
#        across the redirect, which presents as an AUTH failure rather than a
#        routing one.
#   REST /tiingo/equity/intraday/{t}/prices?resampleFreq=1min  200 (gap-fill)
#        ...&afterHours=true  200, bars from 04:00 ET
#   WS   wss://api.tiingo.com/boats  403 "Not authorized for service: boats"
#        <- a REAL entitlement gap. TIINGO_RT_BOATS ships "off" and flipping it
#        today fails; it needs a Tiingo add-on first.
#
# `thresholdLevel` IS A LOADED FOOT-GUN. Levels 0 and 5 are refused with a 400
# reading "thresholdLevel not valid for your subscription tier ... IEX Market
# data rules" — which looks exactly like an entitlement rejection and is NOT
# one: 4 and 6 work on the same key in the same second. `buildSubscribePayload`
# REFUSES to construct a payload carrying an unusable level, so that 400 cannot
# be sent. Classification is on BODY, never on the presence of an error frame.
#
# LEVEL 4 IS REQUIRED, AND THE FEED HAS NO TRADES. Measured across 236 captured
# frames (checked in under `__tests__/fixtures/tiingo-realtime/`): level 6 is
# [ts, ticker, price] and cannot populate a bid/ask quote at all; level 4 is
# [ts, ticker, spread, bidSize, bid, mid, ask, askSize] and every frame is
# TOP-OF-BOOK — none is a print. Consequences that are easy to get wrong:
#   - M1 bars are built from the MID. There is no trade price to use.
#   - `Candle.volume` is written 0, MEANING "this feed does not report volume",
#     never "nothing traded".
#   - so realtime bars carry `source: "TIINGO_RT"`, and one (symbol, timeframe,
#     UTC day) may hold only ONE source. A quote-derived bar beside a
#     trade-derived EOD bar puts a real volume next to a structural zero and
#     changes what OHLC means partway through a day, with nothing on the rows to
#     reveal it. The rule is named after the PROPERTY, not a vendor.
#
#     THE REPOSITORY DOES NOT ENFORCE THIS, and the line above said it did.
#     `putCandles`' upgrade path `$set`s `source` unconditionally — correct for
#     a repository whose job is "write what you are given". The rule therefore
#     has to be applied by the WRITER that knows it is a second source, before
#     the call: `mayWriteIntoDay` in `tiingo-rt-sink-logic.ts`, whose only
#     caller is `workers/src/realtime/candle-sink.ts`. Reading the guarantee as
#     the repository's would leave a new realtime writer unprotected by
#     something that was never there.
# The array layout is pinned from those captured bytes and re-derived
# arithmetically in the suite — (ask-bid)/mid must reproduce the reported spread
# — because this vendor's EOD CSV is documented `date,open,...` and is really
# `date,close,high,low,open`, and a positional parser written from the docs
# swaps open and close on every US security.
#
# THE DAY IS 04:00-20:00 ET, so pre- and post-market ticks arrive on the SAME
# socket. Every quote carries `session: pre|rth|post|closed` from
# `us-market-hours.ts` (new; `market-hours.ts` is NSE-only), because a surface
# rendering a pre-market print as a regular-hours price is wrong in a way the
# number cannot reveal. The staleness alarm stays scoped to RTH.
#
# ONE SOCKET, ONE PROCESS. `tiingo-realtime-{env}` is its OWN Cloud Run service
# on the workers image (a `command` override), minScale = maxScale = 1, and
# `run.googleapis.com/cpu-throttling: "false"` — the first use of that
# annotation in this repo and the reason it is a separate service. Cloud Run
# throttles CPU to near-zero BETWEEN REQUESTS unless it is set, and
# `stockbook-workers` is request-driven and does not set it, so a socket living
# there would be starved between pushes: missed heartbeats, a thrashing
# reconnect loop, and a metered REST snapshot bought on every reconnect.
# A Redis leader lock is STILL required at maxScale 1, because Cloud Run
# overlaps revisions on deploy. It is FAIL-CLOSED (no Redis => not leader), the
# opposite of `cache/client.ts`'s `acquireLock`, which is fail-open with a bare
# DEL and is right for a cache stampede and wrong for a singleton.
#
# THE BUDGET GUARD IS SHARED AND COVERS ALL FIVE LEGS. Every `paceTiingoRequest`
# call site is inside `withTiingoBudget`, enforced by a source scan — it was
# wired at ONE of five for a while, which under-reported spend by ~80% and is
# worse than no guard, because it manufactures headroom that does not exist.
#
# NEWS RUNS 24x7, every 2 minutes. It used to ride `us-eod-sync`'s Tue-Sat
# MARKET cron: measured newest article 88h old, ingest lag 29.6h, and no run at
# all on a Sunday or Monday IST. `UsNewsArticle` is ARTICLE-level (unique on
# Tiingo's article id) with tickers validated against `us_instruments`; the
# cursor walks `crawlDate` with a 30-MINUTE OVERLAP, because that clock is not
# monotonic with our polling and a strict `>` drops a late-crawled article
# permanently, leaving a gap no count can see. `us_stock_news` is untouched and
# read-only until its readers migrate.
#
# RAW TICKS land at `feeds/TIINGO/ws/{date}/` with a 30-day delete rule, and are
# EXCLUDED from the prod->QA mirror by an rsync pattern that a test keeps in
# agreement with the lifecycle prefix. NOTE the mirror job BAKES its script into
# its image, so that exclusion is inert until `setup-sync-job.sh` re-provisions.
CANDLE_COLD_FORMAT=           # MONEY-1384. "parquet" makes the candle COLD
                              # SHARD writer emit parquet; anything else,
                              # including unset, is the gzipped JSONL we write
                              # today. Compared to the LITERAL string and read
                              # PER CALL, never a module-scope const — a
                              # module-level read freezes at import and turns a
                              # redeployed switch into no switch on a warm
                              # container.
                              #
                              # READING is format-agnostic and needs no flag:
                              # the shard KEY carries no extension and the
                              # format is sniffed from magic bytes (gzip `1f 8b`
                              # vs parquet `PAR1`), which is what lets a bucket
                              # sit half-converted without a migration.
                              #
                              # IT DOES NOT SAVE SPACE — measured 2026-09-08, it
                              # COSTS space: a 252-bar D1 symbol-year is 5,809 B
                              # as gzipped JSONL and 9,776 B as parquet (+68%);
                              # an empty shard 20 B against 162 B. Parquet's
                              # fixed footer/schema/page overhead cannot
                              # amortise over a few hundred rows.
                              #
                              # AND M1 DOES NOT INVERT IT — the open question is
                              # CLOSED (MONEY-1518). This line said "M1 shards
                              # are ~86k rows per symbol-year and may well
                              # invert the ratio; MEASURE before converting
                              # them". Measured 2026-09-22 through
                              # `encodeColdShard` itself, on the real prod
                              # objects candles/US/M1/AAPL/{2024,2025}:
                              #
                              #   123,072 rows  1,912,970 B gz  2,364,453 pq  +23.6%
                              #   125,527 rows  1,996,426 B gz  2,454,335 pq  +22.9%
                              #
                              # The overhead amortises (+68% -> +23%) and never
                              # crosses zero, and the curve is NOT monotonic:
                              # the same real bars truncated give +93.2% at 252,
                              # +8.5% at 20k, +7.1% at 50k and +25.3% at 100k, so
                              # a row-group boundary makes a BIGGER shard worse.
                              # THERE IS NO TIMEFRAME AT WHICH CONVERTING THIS
                              # STORE SAVES SPACE. Leave the switch at its
                              # default; what parquet is worth buying for is the
                              # RELEASE artifact below, not a re-encoding of
                              # these keys.
                              #
                              # Volume is written as DOUBLE, not INT64.
                              # hyparquet decodes INT64 as a JS `bigint`, which
                              # the repo's `finite()` guard rejects — so an
                              # INT64 column would drop every bar on read,
                              # silently, and the shard would look empty rather
                              # than broken.
LAKE_RELEASE_APPLY=           # MONEY-1518 (B7). "true" ARMS `lake-release`'s
                              # writes; `--apply` on the command line ASKS and
                              # both are required. Literal string, read per
                              # call, same discipline as the two XBRL flags and
                              # DATABENTO_*_APPLY. A bare `--apply` continues as
                              # a PLAN and says so — the plan is the useful half
                              # of a run whose arm flag was forgotten.
                              #
                              # WHAT IT WRITES: gs://stockbook-lake-{env}/
                              # releases/{release_id}/ — immutable, versioned
                              # parquet a backtest PINS, so the same id re-read
                              # in six months answers the same question.
                              # `releases/` and `rollback/` were already in
                              # LAKE_PREFIXES; nothing wrote them until now.
                              #
                              # IMMUTABILITY IS BIGQUERY'S, NOT OURS. The export
                              # is `EXPORT DATA ... overwrite = false`, so an
                              # existing object fails the statement — a
                              # read-then-write would race a retried job against
                              # itself. `EXPORT DATA` and not `bq extract`
                              # because `gold.adjusted_bar_d1` is a VIEW and
                              # extract jobs refuse views. No row passes through
                              # Node, and export jobs are free of charge.
                              #
                              # IT REFUSES AN EMPTY DATASET, before writing the
                              # manifest. Measured 2026-09-22 on prod:
                              # `trade_bar_m1` and `trade_bar_h1` hold ZERO rows
                              # (MONEY-1514/1515 block their loader) and
                              # `lake_gold_prod` holds no `adjusted_bar_d1` at
                              # all — Dataform has never run there, the dataset
                              # holds only the `instrument_current` view. So a
                              # cut today refuses, by design: an immutable
                              # artifact whose bars_m1/ is an empty directory
                              # reports a clean run on no data, for ever.
                              # `listing` 98,249 · `symbol_history` 98,941 ·
                              # `corporate_action` 59,087 · `price_bar_d1`
                              # 13,649,187 are real and ready.
                              #
                              # THE FACTORS ARE WHY THE PYTHON CRSP PORT COULD
                              # DIE. `bars_d1` carries `price_factor` and
                              # `split_factor_cum`, so `scripts/quant/lake.py`
                              # adjusts ANY timeframe by joining the session
                              # date. `read_candles.py`'s `adjust_series` /
                              # `add_adjusted` are DELETED and `--adjusted` now
                              # REFUSES without `--release`: one policy, two
                              # implementations (TypeScript + the SQL a test
                              # executes against it), never three.
                              #
                              # THE POLICY IS `crsp-v3` (MONEY-1528/1537/1541:
                              # observed-gap CAPITAL_ADJUSTMENT, FLOAT64 factor
                              # arithmetic, twin/composed/partial suppression).
                              # It lives TWICE — `dataform/includes/adjustment.js`
                              # and `lake-release-logic.ts` — bumped together
                              # BEFORE any cut, so no release carries `crsp-v2`;
                              # `dataform-agreement.test.ts` fails if they part.
                              # The manifest prints the policy the ROWS carry
                              # and a cut refuses rows that disagree.
                              #
                              # `duckdb` is NOT a repo dependency and lake.py
                              # does not add one — `pyarrow` (already pinned at
                              # 25.0.1) carries GcsFileSystem, hive pruning and
                              # pushdown. `open_release()` imports duckdb lazily
                              # and names the install if it is absent.
                              #
                              # DATAFORM HAS NO package.json.
                              # `dataformCoreVersion` in
                              # dataform/workflow_settings.yaml is the ONE pin:
                              # Dataform 3 refuses to compile beside a
                              # package.json (measured, CLI 3.0.0, 2026-09-23),
                              # so the project shipped un-compilable until then.
                              # `rolling_stats` is a TABLE rebuilt whole every
                              # run, never incremental: back-adjusted prices
                              # restate history on every split (MONEY-1606).
                              # `event_return_outcome` is the one incremental
                              # model (MONEY-1596).
TIINGO_RT_MAX_SYMBOLS=        # Subscription ceiling (default 3000). The set is
                              # watchlists + holdings + the SSGA SPY list +
                              # SPY/QQQ/DIA/IWM, plus ephemeral page interest on
                              # a sliding TTL. The cap evicts EPHEMERALS first,
                              # soonest-to-expire first — which looks backwards
                              # and is not: an ephemeral expires on its own and
                              # costs a page a few seconds of ticks, while
                              # dropping a BASE symbol removes something a user
                              # HOLDS from the alarm population, the bar series
                              # and the portfolio quote, with nothing to bring
                              # it back.
US_MARKET_ALLOWED_EMAILS=     # WHO MAY RECEIVE US MARKET DATA. Unset =
                              # FOUNDER ONLY (deepshaswat@gmail.com). A CSV
                              # REPLACES that default rather than extending it,
                              # so the list can be narrowed as well as widened;
                              # a blank or all-comma value falls back to the
                              # founder rather than to "everyone" or to nobody.
                              #
                              # This is a LICENCE boundary, not a product flag.
                              # Tiingo COMMERCIAL is INTERNAL USE ONLY: ingest
                              # and storage are fine, SERVING a US price to a
                              # user is redistribution and needs the $250/mo
                              # plan (MONEY-1262). So it is enforced in code
                              # with a safe default rather than in PostHog,
                              # which is remote configuration that can be
                              # flipped by someone who does not know what it is
                              # load-bearing for.
                              #
                              # The `us-stocks-listing` PostHog flag still gates
                              # the PAGE and both must pass. That flag alone was
                              # not enough: it covered the page while
                              # /api/market/quote, /api/market/stream and
                              # /v1/market/us/quotes were behind NOTHING — the
                              # last reachable by any client with a Bearer
                              # token. A dark page in front of open data is a
                              # link nobody has been given yet, which is the
                              # MONEY-1142 shape one feature over.
                              #
                              # Refusal is ABSENCE, never an error: the symbol
                              # is simply unresolved, the shape every caller
                              # already reports. Do NOT set this in a cloudbuild
                              # spec — a test fails if it appears there, because
                              # widening a licence gate must be visible in a
                              # diff.
TIINGO_RT_ARCHIVE=            # "on" in both specs. "off" disables the raw-tick
                              # write to feeds/TIINGO/ws/. Also inert without
                              # GCP_STORAGE_BUCKET, which is what local dev gets.
                              # The archive is a 30-DAY RE-DERIVATION WINDOW,
                              # not a record we promise to keep: if the
                              # aggregator is ever found wrong, the bars can be
                              # rebuilt from the bytes the feed actually sent.
                              # One gzipped object per wall-clock minute, keyed
                              # {date}/{hour}/, with the pid in the name so two
                              # overlapping revisions cannot overwrite one
                              # another. A failed flush DROPS its batch rather
                              # than growing a retry queue during the outage it
                              # would have to survive.
TIINGO_RT_BOATS=              # "off". Overnight (20:00-04:00 ET) only — pre and
                              # post-market are on the MAIN feed. Currently a
                              # 403; needs an add-on before the flag can move.
                              # READ, as of MONEY-1309: setting it "on" now
                              # THROWS at boot with the entitlement named. It
                              # previously shipped in both specs and was read by
                              # nothing, so flipping it changed nothing and
                              # looked like it worked — and a 403 reconnect loop
                              # against a metered vendor reads exactly like a
                              # quiet market.
#
# TIINGO_RT_EPHEMERAL_TTL_S IS GONE, deliberately. It shipped in both specs,
# was read by nothing, and documented a default (900) that disagreed with the
# only live writer (600). The window is now single-sourced in code
# (`tiingo-rt-read-logic.ts`) and derived from there by the planner; an env
# override would reintroduce the fourth spelling of one number, which is the
# defect it was part of rather than a knob anyone asked for.
TIINGO_BUDGET_CONSUMERS=      # Fallback divisor (default 3) when Redis cannot
                              # answer: each process falls back to ceiling/N
                              # rather than stopping. FAIL-DEGRADED, unlike the
                              # EDGAR limiter's fail-closed, because SEC's
                              # penalty is a delayed, unattributable per-IP
                              # block while Tiingo's is an immediate,
                              # attributable 429 the retry ladder handles — and
                              # us-eod-sync has ONE window a day, so a Redis
                              # blip killing it would cost a ~73k-request
                              # backfill.
EDGAR_CIK_ENRICH=             # "off" disables the nightly SEC company_tickers
                              # fetch that joins ticker -> CIK onto US rows.
                              # SEC's access policy REQUIRES a descriptive
                              # User-Agent and enforces it (403 with curl's
                              # default). The join is UPDATE-ONLY, never a
                              # provider: `syncInstruments` upserts on
                              # (symbol, exchange), so a provider whose symbols
                              # differ from ours CREATES duplicates.

# US INTRADAY — Databento (MONEY-1373)
#
# TWO SOURCES, TWO JOBS, AND THE SPLIT IS THE WHOLE DESIGN. Databento is the
# source of BACKTEST-GRADE truth: consolidated, trade-derived, real volume.
# Tiingo stays the source of everything a USER sees. Nothing here touches India
# (`DailyPrice` / `IntradayBar` — MONEY-1043 is decided as COEXISTENCE) or
# Tiingo's daily EOD candles.
#
# WHAT WE ACTUALLY BUY, and it is not the consolidated tape. `EQUS.MINI` is a
# single ANONYMIZED consolidated publisher (`EQUS.MINI.EQUS`, publisher id 95).
# Its bars are TRADE-derived and carry REAL volume — which is the property the
# realtime feed cannot provide at all — but it is a VENUE BLEND, a subset of the
# SIP rather than the SIP itself. Do not describe it as "the tape"; a backtest
# sized against it is sized against a subset, and the difference is exactly the
# kind of thing that never shows up as an error.
#
# HISTORY FLOORS AT 2023-03-28. Not eight years, not "since inception" — that is
# where EQUS.MINI begins, and it is enforced in the manifest's Zod schema
# (`historyFloor >= EQUS_MINI_HISTORY_FLOOR`) rather than left to the operator.
# Asking for a session before it returns an EMPTY result, which is
# indistinguishable from a market holiday and from a broken query.
#
# ── THE ONE-SOURCE RULE, AND WHY THE KEY IS AN ET SESSION DATE ──────────────
#
# A `(symbol, timeframe, session)` holds bars from exactly ONE `source`. That
# rule predates Databento (MONEY-1309, `mayWriteIntoDay`) and is deliberately
# named after the PROPERTY rather than after a vendor: a quote-derived bar
# beside a trade-derived one puts a structural `volume: 0` next to a real
# volume and changes what OHLC MEANS partway through a day, with nothing on the
# rows to reveal it.
#
# THE KEY IS THE ET SESSION DATE, NOT THE UTC DAY, and that changed with this
# ticket. The US session runs 04:00–20:00 ET. Under EST the post-market runs to
# 20:00 ET, which is the NEXT UTC day — and also the UTC day of the FOLLOWING
# session's pre-market. So a UTC key spans the tail of one session and the head
# of the next, and whichever writer lands there first locks the other out of
# BOTH. `usMarketDateKey` is the key; `groupRowsBySession` and
# `RtCandleSink.resolveDayVerdicts` both use it.
#
# DISPLACEMENT IS ONE-WAY. Databento REPLACES a `TIINGO_RT` session wholesale
# (delete, then write — in that order, so a crash leaves a gap rather than a
# mixture). The reverse is REFUSED. `D1` is NEVER displaced by anything, and the
# timeframe guard is load-bearing rather than belt-and-braces: a mutation test
# removing it proved the authority ranks ALONE do not refuse a daily
# displacement. The counter `databento.displaced_d1` must read ZERO forever —
# the manifest's schema enum cannot even express a daily entry, so a non-zero
# value means a writer path exists that no manifest can produce.
#
# PRICE-SOURCE AUTHORITY: BHAVCOPY 100 > TIINGO 60 > DATABENTO 55 > ZERODHA 50 >
# TIINGO_RT 20 > YAHOO 10 > unknown 1. Read the two US ranks together: DATABENTO
# below TIINGO because Tiingo's DAILY bar is the adjusted, corporate-action-aware
# series the app renders and Databento's is raw intraday; DATABENTO far above
# TIINGO_RT because one is trade-derived with real volume and the other is a
# mid-price with a structural zero.
#
# TIMEFRAME LITERALS ARE `M1` / `H1` / `S1`. Never `"1m"`. The repo's timeframe
# vocabulary is `D1` / `M1` / `M5` / `M15` / `H1` / `W1`; the vendor's SCHEMA
# names (`ohlcv-1m`) are converted at exactly one place, `SCHEMA_TIMEFRAME`.
#
# ── THE ARCHIVE ────────────────────────────────────────────────────────────
#
# Raw vendor bytes land at `databento/{dataset}/{schema}/{year}/{jobId}/`,
# DELIBERATELY OUTSIDE `feeds/`: the prod->QA mirror rsyncs that whole prefix
# twice daily and this data is bought, not scraped. Lifecycle is Nearline at 30
# days and NEVER a Delete — these bytes are the only copy of something bought
# once, and deleting them turns a re-load into a re-purchase of a $199 Standard
# month. `databento/` is on BOTH `ALLOW_PREFIXES` and `PROTECTED_ROOTS` in
# `setup-gcs-lifecycle.sh`, and a test fails on a Delete rule under it.
#
# CSV + ZSTD, NOT DBN. Databento's native format is DBN and there is no
# TypeScript decoder for it. The server-side transcode to CSV is FREE and
# billing is on the BINARY size either way, so the choice costs nothing and
# removes a dependency we would have had to write. `pretty_px`, `pretty_ts` and
# `map_symbols` are all on, so prices arrive as decimals and rows carry the
# symbol.
#
# WHICH IS WHY THE WORKERS IMAGE IS NODE 22. `zlib.createZstdDecompress` landed
# in Node 22.15; on 20 there is no stdlib zstd and the alternative is a native
# addon in an alpine/musl image. The bump was verified by REQUIRING the module
# inside the built image, not by trusting the changelog.
#
# OHLCV-1s IS ARCHIVE-ONLY, by founder decision. It is the TB-scale entry and it
# is LAST in the manifest's submit order. Nothing loads it into `candles`; a
# future backtest reads it from the archive. `--apply` without `--entry=` exits
# 1 for exactly this reason — a bare apply would reach it in the same 24-hour
# execution as everything else.
#
# ── THE MONEY ──────────────────────────────────────────────────────────────
#
# `cost_usd` IS NULL AT SUBMISSION. It only appears once the vendor has
# processed the job, so a budget guard reading it at submit time would sum to
# zero — and a budget that reads zero authorises everything. Every purchase is
# therefore QUOTED first through `metadata.get_cost` (free, and it "respects any
# discounts provided by flat rate plans", so a window included in the Standard
# subscription quotes $0.00 — which is how the runbook confirms the
# subscription is live before spending anything).
#
# THE LEDGER REFUSES, IT NEVER TRIMS. A submission that would cross
# `DATABENTO_MONTHLY_BUDGET_USD` throws. Narrowing the window to fit would buy a
# slice nobody asked for and report success, which is the failure shape this
# whole ticket is built around. Every `submitBatchJob(` call site is inside
# `withDatabentoBudget(`, enforced by a SOURCE SCAN — MONEY-1309 is why it is a
# scan and not a review note: a guard wired at one of five legs under-reported
# spend by ~80%, which is worse than no guard because it manufactures headroom.
#
# A WINDOW IS NEVER BOUGHT TWICE, and that is now a database constraint:
# `DatabentoBatchJob` is `@@unique([purpose, entryId, schema, symbolsHash,
# start, end])`. `jobId` is OPTIONAL and only `@@index`ed — the guard creates
# the row in `QUOTED` BEFORE submitting, so a crash between the two leaves a
# visible row rather than spend nobody can find; and MongoDB's unique indexes
# are not sparse, so a unique over an optional `jobId` would admit exactly ONE
# un-submitted row in the whole collection.
#
# FILES EXPIRE 30 DAYS AFTER SUBMISSION — not after completion, which is the
# reading that leaves a job less time than it appears to have. Past it the only
# remedy is to buy the range again, at usage prices, after the subscription has
# lapsed. Rows within two days are reported at ERROR level with a counter.
#
# ── THE TWO JOBS ───────────────────────────────────────────────────────────
#
#   databento-harvest   ONE-TIME, one manifest entry per execution, run by hand
#                       from the runbook. NO scheduler trigger at all — a cron
#                       would be a standing authorisation to spend against a
#                       subscription meant to be cancelled once the harvest
#                       completes. 24 h task timeout, 4Gi.
#   databento-append    NIGHTLY, PROD_ONLY. 2 h task timeout, 2Gi.
#
# THE APPEND RUNS 15:00 IST AND 18:00 IST, TUE–SAT. Not 13:00: the vendor's T+1
# embargo releases the prior session at roughly 09:00 UTC = 14:30 IST, so a
# 13:00 cron would ask for a session that does not exist and get an empty result
# that reads as a quiet market. Tue–Sat because a US session closing 16:00 ET
# lands after midnight IST on the following day. The cron is the CHEAP half of
# that guard; the job also reads `metadata.get_dataset_range` before computing a
# gap, so a late vendor produces a named `NOT_YET_PUBLISHED` skip. The three
# skip reasons (`NO_HWM_RUN_HARVEST_FIRST`, `UP_TO_DATE`, `NOT_YET_PUBLISHED`)
# are DISTINCT values: collapsing them would make a never-harvested entry report
# the same thing, forever, as a perfectly current one.
#
# MONEY-1539/1540 (2026-09-23). The HWM is per PURCHASE WINDOW: the end of the
# newest window with all `expectedChunks` terminal (a per-`symbolsHash` minimum
# pinned MASTER at 09-08 — it re-hashes nightly — so every append re-bought from
# 09-09: 2.16M records for 474k bars). `NO_HWM` ALSO means "no window has all N
# chunks terminal". A QUOTED/FAILED retry TAKES OVER the existing row unless it
# carries a `jobId`. The pacer's `unref()`'d sleep let 7 of 9 15:00 IST appends
# exit 0 MID-SUBMIT — an awaited timer must hold the loop. Runbook §9b makes an
# archive ORPHAN by design (row deleted, bytes kept); the append now flags them
# nightly (`archiveOrphans=`). EQUS-20260907-CXDTCWL9HP is a documented
# duplicate of EQUS-20260908-BN8RS9XMHF, deliberately not recorded.
#
# lake-load-databento RUNS AS lake-writer-{env}@ (MONEY-1544 branch). As
# stockbook-api@, which holds nothing on BigQuery, its first four in-region runs
# on 2026-09-23 exited 1 "Access Denied" on trade_bar_h1 and stranded 43 LOADING
# claims. It mounts NO GCP_SERVICE_ACCOUNT_KEY_BASE64 — googleCredentials()
# resolves a key FIRST and would put stockbook-api@ back (the MONEY-783 trap) —
# and reads the archive through an objectViewer grant scoped to `databento/`.
#
# QA RECEIVES ROWS, NOT BYTES. Databento is a paid metered vendor and QA never
# spends there. `candles`, `databento_batch_jobs`, `us_cost_model_versions` and
# `us_cost_model_rows` are in `sync-prod-to-qa.sh`'s REFERENCE_COLLECTIONS, so
# QA gets exactly what prod computed — the same arrangement as `us-eod-sync`,
# and strictly safer than the feeds REPLAY arrangement, where a mirror miss
# silently re-spends the quota instead of degrading.
#
# ── THE TRANSACTION-COST MODEL ─────────────────────────────────────────────
#
# Built MONTHLY from the archived `bbo-1m` quotes, into `us_cost_model_rows`:
# one median and 75th-percentile spread per (listing, time-of-day bucket), plus
# a liquidity tier. Reads are VERSION-PINNED — a backtest run against March's
# spreads and re-run in September against September's produces two different
# P&Ls from identical inputs, with nothing in either result to say why. The
# version bumps in ONE place, the append's monthly trigger.
#
# TWO SCHEMAS, TWO STATISTICS, AND THEY MUST NOT MIX (MONEY-1373 D1).
# `bbo-1m` is TIME-UNIFORM — one record a minute per symbol whether or not
# anything traded — and it is the QUOTED spread and the quoted size. `tbbo` is
# ACTIVITY-WEIGHTED — one record per trade, so a busy minute contributes
# hundreds and a quiet one none — and it is the EFFECTIVE spread and NOTHING
# ELSE. Folding a tbbo row's quote into `spread` as well would re-weight the
# quoted statistic toward the moments people were trading, which is when
# spreads are tightest: a number that looks like a quoted spread, sits in a
# column called `quotedSpreadBps`, is biased low, and carries nothing in the
# row to say so. `foldQuoteFile({kind})` is the one place that decides, and a
# golden fixture pins that a tbbo stream leaves the bbo `sampleCount` unmoved.
#
# The timestamps also differ. `bbo-1m`'s `ts_recv` is the interval END, so it
# is bucketed one millisecond back — a 16:00:00.000 record belongs to the
# session that closed, not the one that follows. `tbbo`'s is the EVENT stamp of
# one print and is used as-is.
#
# THE TBBO FOLD WINDOW IS ANCHORED AT THE ARCHIVE, not at `now`. The manifest
# entry is `append: false` — bought once inside the live Standard month and
# never topped up — so a `now - 92d` window goes silently empty about three
# months after the harvest and every rebuild after that drops
# `effectiveSpreadBps` from every row while still reporting a READY model.
# `tbboFoldWindow()` is a pure function for exactly that reason: a source scan
# cannot tell `archiveEnd` from `now`.
#
# 92 days of trades, against 12 months BOUGHT. The purchase is 12 months
# because it is a one-way buy at $0; the FOLD is 92 days because top-50
# megacaps are ~4-8M rows a day, so 92 days is ~250-500M lines through
# `zstdLines` — 10-30 minutes in Node, inside the append's 2 h task timeout,
# where a 12-month fold would not be.
#
# A trade-only cell is DROPPED, not written: `summarizeCell` returns null with
# no quoted sample, because the model is costed on the quoted spread and
# effective is a supplement to it. Safe because TOP50 is a strict subset of
# BASELINE (verified 2026-09-07: 0 missing).
#
# The field names in `packages/types/src/us-cost-model.ts` ARE the Mongo field
# names, because the quant engine is PYTHON and reads the collections directly:
# a rename that "only changes TypeScript" breaks a consumer no TypeScript build
# can see.
DATABENTO_API_KEY=            # SECRET. Secret Manager DATABENTO_API_KEY_QA /
                              # _PROD, mounted on the two JOBS only. HTTP BASIC
                              # auth with the key as the USERNAME and an empty
                              # password — not Bearer, not a custom header.
DATABENTO_HARVEST_APPLY=      # "true" ARMS the one-time harvest's writes.
                              # Ships PRESENT and "false" from
                              # setup-databento-jobs.sh — absent and "false"
                              # must not be the same state (MONEY-1214).
                              # Compared to the LITERAL string, never Boolean():
                              # Boolean("false") is true. Read PER CALL, never a
                              # module-scope const — a module-level read freezes
                              # at import and turns a redeployed switch into no
                              # switch on a warm container.
                              #
                              # `--apply` on the command line ASKS; this ARMS.
                              # Both are required. `--apply` without the arm
                              # continues AS A DRY RUN and says so, because the
                              # operator still gets the quote report, which is
                              # the useful half.
DATABENTO_APPEND_APPLY=       # "true" ARMS the nightly append. Same literal
                              # comparison, same per-call read, same
                              # present-and-"false" discipline. SEPARATE from
                              # the harvest flag on purpose: the harvest is a
                              # one-time buy a human supervises and the append
                              # is a standing schedule, and the state "append
                              # armed, harvest not" is the steady state.
DATABENTO_MONTHLY_BUDGET_USD= # Default 25. A REFUSAL threshold, not a trim.
                              # Raise it deliberately or split the manifest
                              # entry; do not let a job narrow its own window.
DATABENTO_ENV=                # prod | qa. Stamped on every inventory row so one
                              # ledger can hold both environments' purchases
                              # without them summing together.
#
# NONE OF THESE BELONG IN workers/cloudbuild.*.yaml. A Cloud Run JOB does not
# inherit the SERVICE env block, so setting them there would look like
# configuration and do nothing — and the specs' inline heredocs have roughly 100
# characters of slack over the 700-char headroom floor, which is not enough to
# spend on variables the jobs cannot see. They live on the JOBS, set by
# `scripts/ops/setup-databento-jobs.sh`, and a test fails if they appear in a
# service spec.

# US fundamentals — SEC EDGAR (MONEY-979), services/us-fundamentals
#
# A PYTHON Cloud Run service, because the parser is Python: edgartools maps
# 2,923 XBRL tags onto ~95 standard concepts and parses Forms 3/4/5, 13F, 13D/G
# and 8-K exhibits. It lives in `services/` rather than `apps/*` or `packages/*`
# because those two are literal Yarn WORKSPACE GLOBS — a directory there needs a
# package.json or `yarn install`, Turbo's task graph and gen-test-coverage.ts
# all break on it. `services/` is language-neutral and top-level, the same shape
# `workers` has; a future Rust service goes in the same place. Docker is the
# deployment boundary, not Turbo. The seam to the TS side is Mongo + Pub/Sub,
# never an import, and a test enforces that.
#
# ONLY PROD FETCHES FROM SEC. Cloud Run has shared egress IPs and SEC's
# fair-access limit is PER IP, so two environments scraping one budget is two
# environments getting blocked. QA runs SEC_EGRESS=off — every client method
# raises before opening a socket — and receives rows through sync-prod-to-qa.
#
# THE LIMITER IS OURS, NOT THE LIBRARY'S. edgartools' own docs claim
# "distributed rate limiting"; the source does not have it. `httpclient.py:205`
# builds a per-process `InMemoryBucket` from EDGAR_RATE_LIMIT_PER_SEC. N
# instances x 9 req/s is exactly how an IP gets blocked, so we assign a
# pyrate_limiter RedisBucket to `edgar.httpclient.HTTP_MGR.rate_limiter` (it is
# looked up at CALL time; no module captures it) and share ONE bucket across
# every instance and job. It FAILS CLOSED: Redis unreachable stops the run
# rather than silently reverting to per-process 9/s, because that fallback is
# invisible until the block arrives. The library also NEVER retries 429 and
# never sleeps on Retry-After — and SEC sends neither, signalling a block with a
# 403 and a BODY ("Undeclared Automated Tool"), so classification is on body
# text, never on status.
EDGAR_IDENTITY=               # The User-Agent, sent VERBATIM and unvalidated by
                              # the library. SEC's own template is `Name email`
                              # (no parentheses). Required — SEC 403s without a
                              # declaring UA. Plain value in both cloudbuild
                              # specs: "UseMoney deepshaswat@gmail.com".
SEC_RATE_LIMIT_PER_SEC=       # Default 9, against SEC's published 10. One
                              # SHARED budget via Redis (needs REDIS_URL, which
                              # the Cloud Run JOBS must be given explicitly —
                              # a job does NOT inherit the service env block).
SEC_EGRESS=                   # "archive" on prod (fetch + archive to GCS),
                              # "off" on QA (raise before any socket). UNSET is
                              # treated as off: a new environment must opt IN to
                              # spending a shared, per-IP quota.
DD_METRICS_TRANSPORT=         # MONEY-1278. "http" on the five Cloud Run JOBS,
                              # "statsd" on the SERVICE. Not a preference — a
                              # property of where the process runs. The service
                              # has a `datadog-agent` sidecar listening on UDP
                              # 8125; the JOBS have NO sidecar, so every counter
                              # they emitted was refused by a closed port and
                              # dropped, silently, while `[job-outcome] {...}`
                              # logged perfectly. DogStatsD is fire-and-forget,
                              # so nothing failed and the metric simply never
                              # arrived — which renders as NO DATA, not as an
                              # alert, and is indistinguishable from an idle
                              # healthy job. On "http" the outcome POSTs to
                              # api.us5.datadoghq.com/api/v1/series and needs
                              # DD_API_KEY (also newly mounted on the jobs);
                              # without the key it NO-OPS, matching
                              # `datadog-metrics` on the TypeScript side.
                              # Compared to the LITERAL string: bool("statsd")
                              # is true, so a coercion would put the SERVICE on
                              # HTTP and have it bypass its own healthy sidecar.
                              # Both specs ship it PRESENT (MONEY-1214).
EDGAR_LOCAL_DATA_DIR=         # /tmp/edgar. edgartools mkdirs its data dir AT
                              # IMPORT and writes an HTTP cache there; Cloud
                              # Run's filesystem is read-only except /tmp.
EDGAR_DETECT=                 # "on" arms the minutely getcurrent walk.
                              # SHIPS ARMED ON PROD ("on"), off on QA.
EDGAR_PARSE_APPLY=            # "true" arms the five parsers' writes.
                              # SHIPS ARMED ON PROD ("true"), off on QA.
EDGAR_EVICT_APPLY=            # "true" arms the 13F evictor's DELETES.
                              # OFF IN BOTH — the one exception, and not out of
                              # caution. The 13F cold tier it evicts into is
                              # registered at boot but UNREACHABLE:
                              # `getManagerHoldings` is its only reader and has
                              # zero callers, so eviction would delete readable
                              # rows and then answer "not yet ingested" for
                              # periods whose shards sit unread in GCS. Harmless
                              # on day one, wrong a quarter later. Arm it once a
                              # manager-side tool consumes the cold tier —
                              # docs/reference/edgar-engine.md section 11.
                              #
                              # The INGEST PATH SHIPS RUNNING, the way the
                              # Tiingo US backbone shipped (MONEY-980: live
                              # schedules, no apply flag at all). A feature
                              # behind an off switch is a feature that does not
                              # exist — nothing exercises its write path and the
                              # monitors have no series to watch.
                              #
                              # QA is off because it has NO SEC EGRESS
                              # (SEC_EGRESS=off; the fair-access limit is PER IP
                              # and Cloud Run shares egress addresses). An armed
                              # detector there would raise on all 1,440 runs a
                              # day. Forced, not chosen.
                              #
                              # All three are still PRESENT in both specs.
                              # Absent and explicitly-set must not be the same
                              # state — that is how MF_METADATA_PROVIDER
                              # disabled its job silently for months
                              # (MONEY-1214). Compared to the LITERAL string,
                              # never Boolean(): Boolean("false") is true.
                              # `INTENDED_FLAG_STATE` in
                              # tests/test_deploy_contract.py pins BOTH
                              # directions, so a silent disarm fails too.
OPENFIGI_API_KEY=             # GCP Secret Manager: OPENFIGI_API_KEY_QA / _PROD.
                              # Bloomberg's CUSIP -> ticker mapping, the LAST of
                              # four tiers (13D/G cover pages, the 13F `figi`
                              # column joined to UsInstrument.openFIGIComposite,
                              # and SEC's Fails-to-Deliver files come first —
                              # three primary sources before any vendor).
                              # FREE, no paid tier. Keyed: 25 requests per 6
                              # seconds, 100 CUSIPs per request; unkeyed 25/min
                              # x 10. The FIGI identifiers are a PUBLIC-DOMAIN
                              # DEDICATION — storable, displayable and
                              # redistributable to customers, no attribution
                              # clause. Note OpenFIGI spells share classes with
                              # a slash (BRK/B) where our master uses a dash.
#
# STORAGE: GCS prefix `edgar/`, deliberately OUTSIDE `feeds/` — the prod->QA
# mirror rsyncs that whole prefix twice daily and raw filings grow ~330 GB/yr.
# Bulk zips are deleted at 30 d; submission bundles are permanent (Nearline at
# 30 d) because a reparse must never cost a SEC request.
#
# AMOUNTS ARE USD, in a `currency` column. No FX here; dual denomination is
# MONEY-982. Every existing financial consumer in this repo hardcodes a rupee
# symbol, which is precisely how a currency-less amount becomes wrong.
#
# Full design, measured facts and runbook: docs/reference/edgar-engine.md
```

### Datadog Observability

`dd-trace` requires a local Datadog Agent (localhost:8126). On Cloud Run, this
is provided by a sidecar container. On Vercel there is no agent, so APM spans go
nowhere — but RUM, Logs, Metrics **and LLM Observability** all work, because
each posts over HTTPS to an intake rather than to `localhost:8126`.

**`DD_TRACE_ENABLED` is `true` on Vercel now, and that is not a contradiction**
(MONEY-1380). LLM Obs initialises INSIDE `if (config.tracing !== false)`
(`dd-trace/src/proxy.js`), so the old `DD_TRACE_ENABLED=false` kept it off
entirely. The pair is `DD_TRACE_ENABLED=true` + `DD_APM_TRACING_ENABLED=false`:
tracing on so LLM Obs can start, APM spans suppressed because nothing would
receive them. MONEY-718 (real Vercel APM) is unchanged by this — standalone
mode is not APM, the spans still die at the writer.

| Service                 | Variable                                     | Required    | Notes                                                                                                                                                          |
| ----------------------- | -------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workers (Cloud Run)** | `DD_TRACE_ENABLED=true`                      | Yes         | Enable APM tracing                                                                                                                                             |
|                         | `DD_API_KEY`                                 | Yes         | GCP Secret Manager (`DD_API_KEY_PROD` / `DD_API_KEY_QA`)                                                                                                       |
|                         | `DD_SERVICE=stockbook-workers`               | Yes         | Service name tag                                                                                                                                               |
|                         | `DD_ENV=production/qa`                       | Yes         | Environment tag                                                                                                                                                |
|                         | `DD_VERSION=$COMMIT_SHA`                     | Recommended | Version tracking (set by Cloud Build)                                                                                                                          |
|                         | `DD_TRACE_AGENT_URL=http://localhost:8126`   | Yes         | Points to Datadog sidecar                                                                                                                                      |
|                         | `DD_SITE=us5.datadoghq.com`                  | Yes         | Sidecar env only; must equal `DD_SITE` in `packages/datadog/src/constants.ts` (org moved us3 -> us5, Sep 2026, MONEY-1229; pinned by `site-agreement.test.ts`) |
|                         | `DD_LLMOBS_ENABLED=1`                        | Yes         | MONEY-1380. `stockbook-workers` container ONLY — not `tiingo-realtime`, which makes no model call. The ONLY var that fits: 41 chars of arg headroom remain     |
| **Web (Vercel)**        | `DD_TRACE_ENABLED=true`                      | Yes         | **Was `false`.** LLM Obs cannot start under `false` — see the note above                                                                                       |
|                         | `DD_APM_TRACING_ENABLED=false`               | Yes         | Standalone mode: no APM spans shipped, LLM Obs runs                                                                                                            |
|                         | `DD_LLMOBS_ENABLED=1`                        | Yes         | MONEY-1380                                                                                                                                                     |
|                         | `DD_LLMOBS_AGENTLESS_ENABLED=1`              | Yes         | Posts to the intake over HTTPS; no agent needed                                                                                                                |
|                         | `DD_API_KEY`                                 | Yes         | For logs + metrics via HTTP                                                                                                                                    |
|                         | `DD_SERVICE=stockbook-web`                   | Yes         | Service name tag                                                                                                                                               |
|                         | `DD_ENV=production`                          | Yes         | Environment tag                                                                                                                                                |
|                         | `NEXT_PUBLIC_DD_APPLICATION_ID`              | Yes         | RUM application ID                                                                                                                                             |
|                         | `NEXT_PUBLIC_DD_CLIENT_TOKEN`                | Yes         | RUM client token                                                                                                                                               |
|                         | `NEXT_PUBLIC_DD_ENV`                         | Yes         | RUM environment tag                                                                                                                                            |
|                         | `NEXT_PUBLIC_DD_VERSION`                     | Optional    | RUM version tag                                                                                                                                                |
| **API (Vercel)**        | `DD_TRACE_ENABLED=true`                      | Yes         | **Was `false`.** Same reason as web                                                                                                                            |
|                         | `DD_APM_TRACING_ENABLED=false`               | Yes         | Standalone mode                                                                                                                                                |
|                         | `DD_LLMOBS_ENABLED=1`                        | Yes         | MONEY-1380                                                                                                                                                     |
|                         | `DD_LLMOBS_AGENTLESS_ENABLED=1`              | Yes         | HTTPS intake                                                                                                                                                   |
|                         | `NODE_OPTIONS=--import dd-trace/register.js` | Yes         | **API ONLY.** Its bundle is ESM, and dd-trace patches ESM only through the loader hook. Web needs none — its externals resolve to CJS                          |
|                         | `DD_API_KEY`                                 | Yes         | For logs + metrics via HTTP                                                                                                                                    |
|                         | `DD_SERVICE=stockbook-api`                   | Yes         | Service name tag                                                                                                                                               |
|                         | `DD_ENV=production`                          | Yes         | Environment tag                                                                                                                                                |

**GCP Secret Manager secrets to create:**

- `DD_API_KEY_PROD` - Production Datadog API key
- `DD_API_KEY_QA` - QA Datadog API key
- `DD_APP_KEY_PROD` / `DD_APP_KEY_QA` - Datadog APPLICATION key (UI-minted; read by
  every provisioning script in `scripts/ops/datadog/` — the four `apply-*.sh`,
  plus `create-rum-apps.sh`, `setup-datadog.sh`, `set-dd-secret.sh` and the
  shared `lib-datadog.sh` — never by a service — MONEY-1229)
- `DD_MONGO_MONITOR_PASSWORD_PROD` - the Atlas `datadog_monitor` user's password,
  read only by `setup-dbm-host.sh` when it renders the agent config (MONEY-1377)

**THE SITE IS `us5.datadoghq.com`, and it is spelled ONCE.**
`packages/datadog/src/constants.ts` `DD_SITE` is the single source; the logs
intake URL derives from it. The surfaces that CANNOT import a TypeScript
constant — the four Cloud Build sidecar specs and `workers/scripts/deploy.sh` —
carry it as a literal, and `site-agreement.test.ts` holds them in agreement.
A mismatch is answered 403 and swallowed by the agent, so it presents as NO
DATA rather than as an error.

### LLM Observability (MONEY-1380)

Every Gemini, Claude and Vertex call the product makes is traced, priced and
attributed to a FEATURE. It is `dd-trace`'s own LLM Obs — no new vendor, no new
dependency: 5.85.0 already ships `llmobs/plugins/{genai,anthropic,vertexai}`
and our SDK versions are inside their supported ranges.

**THE TRACER CONFIG MUST NOT CARRY AN `llmobs` KEY WHEN THE FEATURE IS OFF.**
`dd-trace/src/config/index.js:1023` self-enables LLM Obs on the mere PRESENCE
of the option:

```js
if (this.#env['llmobs.enabled'] == null && options.llmobs) { ...true }
```

A config that always carried it would enable LLM Obs in every local dev shell
and CI run — and enabling it with no agent and no API key is not a quiet
degrade. `setAgentStrategy` probes the agent, fails, selects agentless, and
`llmobs/index.js:69` THROWS from inside an async callback, where no caller's
try/catch can reach it. `llmobsConfig()` therefore returns `undefined` and
`tracerConfig` spreads the key in, so "off" is genuinely ABSENT.

**`agentlessEnabled` IS ALWAYS AN EXPLICIT BOOLEAN**, never left undefined —
false on Cloud Run (there is a sidecar), true on Vercel (there is not).
`setAgentStrategy` returns immediately when the value is non-null and otherwise
probes the agent's `/info`. That probe is a BOOT RACE: an app container that
starts before its `datadog-agent` sidecar is ready gets an error, flips to
agentless, and — our app containers carry no `DD_API_KEY`, only the sidecar
does — throws and takes the process down. Stating the strategy removes the race
rather than narrowing it.

**`workers/Dockerfile` STARTS NODE WITH `--import dd-trace/register.js`, and
that flag is what makes instrumentation work at all here.** tsup emits ESM
(`format: ["esm"]`) with every non-workspace dependency external, so
`dist/index.js` carries real `import` statements for `@google/genai` and
`@anthropic-ai/sdk`. dd-trace patches CommonJS through `require-in-the-middle`,
which needs nothing, but patches ESM through `import-in-the-middle`, which must
be registered before the process loads anything. The estate already carried the
fingerprint of this: until the loader shipped (~2026-09-11) the only server span
observed live for `stockbook-workers` was `web.request` (core `http`, via
diagnostics_channel — no loader needed), and `apply-service-monitors.sh` records
our Gemini calls arriving as OUTBOUND `http.request`, the transport and never
the model call. It is now `hono.request` — dd-trace's Hono plugin (loader-only)
renames the same span, which is live proof the loader works and was the cause of
MONEY-1534 (next paragraph).

**THE APM SERVER SPAN IS PER SERVICE, and a loader change renames it**
(MONEY-1534). Measured 2026-09-23: `stockbook-workers` and
`usemoney-market-data` emit `hono.request`, `tiingo-realtime` `web.request`,
`us-fundamentals` `fastapi.request`. It is declared ONCE in `DD_SERVER_SPAN`
(`packages/datadog/src/constants.ts`), read by `dd_server_span` for the
monitors, and held for `slos.json` and the dashboards by agreement tests. When
the workers span moved, the error-rate monitor sat in No Data for ~11 days
because its DENOMINATOR (`web.request.hits`) stopped existing — not because of
the errors series, which has no data on every healthy service.

Use `register.js`, NOT `initialize.mjs` — the latter ALSO calls `tracer.init()`
from the environment, which would construct a tracer before `initTracer` runs
and override the options resolved in code (profiling and runtimeMetrics among
them, which MONEY-1357 turns off for one process on purpose). Deliberately NOT
applied to `tiingo-realtime` (its `command:` override; no model call) or to the
Cloud Run JOBS.

**apps/api HAD NO TRACER IN PRODUCTION AT ALL.** The Vercel entry point
(`api/[[...route]].ts`) imports `../dist/app.js`, built from `src/app.ts`; the
`initTracer` call lived in `src/index.ts`, which is the LOCAL DEV entry and says
so in its own header. `src/tracer.ts` is now side-effect imported from the top
of `app.ts` (ESM evaluates imports in source order). `index.ts` keeps its call —
`initTracer` latches.

**`next.config.js` EXTERNALIZES `@google/genai` AND `@anthropic-ai/sdk`.** A
module webpack has inlined into the server bundle is never `require`d, so the
loader hook never fires and the call is untraced with no error anywhere.

**PROFILING AND RUNTIME METRICS MUST BE PASSED AS OPTIONS ON VERCEL**, not set
by env: `tracerConfig` defaults both to `true` and an explicit option beats the
environment, so no Vercel project setting can turn them off.

**`ml_app` IS THE GROUPING EVERYTHING HANGS OFF, and it is inherited.**
dd-trace resolves it as `explicit ‖ parent LLMObs span's ‖ propagated tag ‖
config ‖ service name` (`llmobs/tagger.js`), so wrapping ONE entry point per
feature with `llmWorkflow()` (`@usemoney/datadog/llmobs`) tags every model call
underneath it — including calls several packages deep. An unwrapped call is NOT
dropped; it lands under the service name, a visible "not yet attributed"
bucket. The vocabulary is per FEATURE, not per service or package:

| ml_app       | entry points                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research`   | `research.ts`, `comparison.ts`, `preview-plan.ts` (workers) + `/api/research/preview-plan`                                                                |
| `analysis`   | `l3-analysis.ts` — cleanup cron handled OUTSIDE the span, it makes no model call                                                                          |
| `roast`      | `roast.ts`                                                                                                                                                |
| `briefing`   | `login-briefing.ts`                                                                                                                                       |
| `doc-ingest` | `stock-document-ingest.ts`, `stock-document-parse.ts`                                                                                                     |
| `video`      | `studio-render.ts`                                                                                                                                        |
| `chat`       | `/api/chat`, `/api/screener-chat`                                                                                                                         |
| `fire`       | the web action AND `/v1/fire` — wrapped at both CALLERS, because `packages/fire` is a shared library and wrapping it would open a span for every importer |

**EVERY WRAPPER IS DECLARED `async`.** That is a BUILD constraint, not style: a
Next.js `"use server"` module rejects `export function x(): Promise<T>` with
"Server Actions must be async functions" — identical types, so no type-checker
sees it. Enforced by a test across both apps and the workers.

**PROMPT AND COMPLETION TEXT IS CAPTURED BY DEFAULT AND THERE IS NO TOGGLE.**
The JS SDK parses exactly three keys — `DD_LLMOBS_ENABLED`, `DD_LLMOBS_ML_APP`,
`DD_LLMOBS_AGENTLESS_ENABLED` — with no span character limit. For this product
that text can contain portfolio holdings. The decision is to allow it and scrub
Datadog-side with a Sensitive Data Scanner rule on the LLM Obs product; a test
pins the capture so the policy cannot be forgotten silently.

**NOT COVERED, measured rather than assumed:** `services/us-fundamentals` and
`tiingo-realtime` make ZERO model calls (the ticket listed the first — it is
wrong). Embeddings go through a raw `fetch` in
`packages/core/src/embeddings.ts:115` rather than `ai.models.embedContent`, so
the genai plugin never sees them — a follow-up, not a gap in this wiring.

**NO MONITORS YET**, per MONEY-1238: instrument, observe the series arriving,
then monitor. Nothing may read `ml_obs.*` until QA has been seen producing it.

### Datadog's Google Cloud integration (MONEY-1379)

`scripts/ops/datadog/setup-gcp-integration.sh`, six idempotent stages, STS
service-account impersonation (no downloaded key). It takes NO `{qa|prod}`
argument — one GCP project, one Datadog org.

**THE ONE THING IT CANNOT DO** is enable the Detailed Usage Cost BigQuery
export: that is console-only, and it accumulates ONLY FROM THE DAY IT IS
SWITCHED ON, so every day of delay is cost history that never exists. Stage 4
is therefore FAIL-CLOSED on the export table's presence — writing a cost config
over an empty dataset would look configured and report nothing. Cost data then
takes 48-72h to stabilise, so `verify` prints `pending` rather than failing.

**IT MAKES FIVE MORE GCE VMs BILLABLE** as Datadog infra hosts. MONEY-1379
estimated four; the live project has SIX, and one (`usemoney-prod-datadog-agent`)
has been billed since MONEY-1377 — so the NEW cost is five. Measured
2026-09-11: `usemoney-prod-redis`, `usemoney-qa-mongodb`, `usemoney-qa-redis`
(in nobody's list), `algo-prod-worker`, `algo-research-worker`. Host count went
5 -> 10 within minutes of registering. Never restate this from a ticket; run
`gcloud compute instances list`.

**OWNERSHIP BOUNDARY — this repo covers stockbook's workers and VMs ONLY.**
`algo-prod-worker` and `algo-research-worker` belong to the `claude-algo` repo
and are handed over to it in full: the agent on those boxes, APM, logs and any
custom metrics are ITS work, not this repo's. Nothing here should install,
configure or alert on anything running inside them.

They are nonetheless DISCOVERED by this integration, and that is topology
rather than scope creep: Datadog's GCP integration is registered per PROJECT,
and every one of these VMs lives in `stock-book-483718`. There is no second
integration the algo repo could register for the same project. So the split is:
this repo owns the project-level integration and the infra metrics it yields;
the algo repo owns everything INSIDE its two boxes. If those VMs should stop
being discovered at all, that is `host_filters` here — a deliberate decision
that leaves them with no infra metrics until the algo repo's own agent lands.

The `algo-*` pair is separated by ATTRIBUTION, not exclusion (founder decision):
both carry the GCP label `product=algo-test-module`, which the integration
imports as the host tag `product:algo-test-module`. GCP instance labels become
Datadog host tags on the next crawl — verified, `algo-research-worker`'s
pre-existing `plane`/`role` labels arrived that way. `host_filters` stays EMPTY
and remains the lever if exclusion is ever wanted instead.

**The monitors exist now** — `apply-perf-monitors.sh`, nine of them, and the
ordering rule was honoured rather than skipped: the integration went in, the
series were observed arriving (798 of them), and only then was anything alerted
on. Pub/Sub `oldest_unacked_message_age` and Cloud Run instance-count
saturation were the two candidates named here, and both shipped.

Every row is PREFLIGHTED against the live org before it is written, and that is
the whole permission structure. These names are supplied by a VENDOR CRAWL, not
by our emitters, so there is no local constant to compare against —
`dd_metric_has_points` asking the org is the only check that can exist, and it
answers in three states: points (proceed), none (REFUSE that row by name), or
DID NOT RUN (fatal — a 403 or a rate limit must never read as "the series is
empty"). `gcp-integration-agreement.test.ts` used to forbid any `gcp.*` monitor
outright, with a comment saying to replace the rule in the same change that
adds the first one; it now enforces the narrower rule it always meant, which is
that a `gcp.*` series may be alerted on only through the script that checks it
is live first.

**Scope is a NAME, never `*`, and the guard is in the script itself.**
`oldest_unacked_message_age by {subscription_id}` returns 190 series, including
`*-pull-local` subscriptions that NOTHING drains — their oldest message is
always old, so a wildcard monitor alerts forever on a perfectly healthy estate.
And `algo-api-prod` / `algo-workers-prod` are Cloud Run services in this same
project owned by the algo repo (see the ownership boundary above); they enter
`by {service_name}` the moment they scale above zero. The Gemini quota row is the
one permitted wildcard — one project, one quota, no env dimension to narrow by.

**A Cloud Run JOB has no sidecar; a Cloud Run SERVICE does.** That is one fact
with two spellings, and getting it wrong is silent in both directions:

| Runtime                                                   | Transport                      | Set by                                     |
| --------------------------------------------------------- | ------------------------------ | ------------------------------------------ |
| the 3 SERVICES: workers, us-fundamentals, tiingo-realtime | DogStatsD (UDP localhost:8125) | the `datadog-agent` sidecar in the spec    |
| the TypeScript Cloud Run JOBS                             | HTTP to `api.{DD_SITE}`        | `DD_API_KEY` **only**                      |
| the 5 Python Cloud Run JOBS                               | HTTP to `api.{DD_SITE}`        | `DD_API_KEY` + `DD_METRICS_TRANSPORT=http` |

**`DD_METRICS_TRANSPORT` IS PYTHON-ONLY.** This table used to give it to all
twelve jobs, and that is wrong in a way that costs work: `grep -rn
DD_METRICS_TRANSPORT packages/` returns NOTHING. The TypeScript path wraps
`datadog-metrics`, which posts to the HTTP API and needs no agent — it is gated
on `DD_API_KEY` alone (`packages/datadog/src/metrics.ts:18`). Adding the
variable to a TS provisioner is inert, and MONEY-1378 was filed demanding
exactly that for seven scripts before anyone checked. The Python half is the
half with a choice to make: `settings.py` `metrics_transport()` reads it and
defaults to DogStatsD, which a job has no sidecar for.

**A JOB'S CONFIG IS PINNED AT SETUP TIME, so fixing the provisioner is only
half.** MONEY-1278 corrected these scripts; the jobs kept the env they were
created with. Measured 2026-09-06, months later: `feed-parse-prod` and
`xbrl-reparse-prod` still carried NO `DD_*` env at all, so `reportJobOutcome`
no-op'd — while `feed-parse` sat in `MONITORED_JOBS` watching a series that had
never existed. `job-metrics-path.test.ts` passes throughout, because it scans
the SCRIPT. Re-run `setup-*-job.sh` after any change to a job's env, and read
the deployed state rather than the spec.

DogStatsD is fire-and-forget, so a job pointed at a port with no listener logs
`Connection refused` and drops every counter while its `[job-outcome]` line
prints perfectly. **A metric that never arrives renders as NO DATA, not as an
alert** — and NO DATA is also what an idle, healthy, correctly-configured job
looks like (MONEY-1278).

**What is monitored, and by which script.** All four are idempotent, tagged
`managed-by:`, and take `{qa|prod} [--dry-run]`:

| Script                      | Applies                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apply-monitors.sh`         | 70 prod / 0 qa JOB monitors — 41 zero-write, 27 absence (18 standing + 9 sparse), 1 latency, 1 tripwire |
| `apply-service-monitors.sh` | 13 prod / 0 qa SERVICE monitors — APM, logs, RUM, realtime liveness                                     |
| `apply-perf-monitors.sh`    | 9 prod / 0 qa PERFORMANCE monitors over the GCP integration                                             |
| `apply-slos.sh`             | the SLOs over those monitors — two cover a DECLARED subset                                              |
| `apply-dashboards.sh`       | the dashboards                                                                                          |

**All three monitor scripts answer `--only=verify`** (MONEY-1379): render every
row, write nothing, ask Datadog what it holds under the managed tag, and exit
**3** when the two disagree — printing all three sets, because an ORPHAN (live
in Datadog, deleted from the script, still alerting) and a MISSING row (in the
script, never applied) need opposite fixes. It is deliberately not `--dry-run`:
a dry run has no credentials, skips the listing and short-circuits every
preflight, so a comparison against a listing it never made would be a claim with
no evidence.

**THE OLDER TWO SHARE ONE MANAGED TAG, and that limits what verify can say
about them.** `apply-monitors.sh` and `apply-service-monitors.sh` both tag with
AND list by `managed-by:apply-monitors` — measured 2026-09-13, the live org
holds **77** monitors under it (75 on 2026-09-11; the count moves with every
apply, so re-measure rather than cite). So each script sees the other's as
unrendered.
`dd_verify_managed` therefore takes an EXCLUSIVE flag: for those two it reports
the extra set as "under the tag, not mine" and does NOT fail, because from one
script alone that set cannot be told apart from a sibling's monitors. The
MISSING half stays authoritative for all three — a row the repo renders that the
org does not have is drift no matter who shares the tag — and that is the half
that catches "somebody edited the script and never applied it". Only
`apply-perf-monitors.sh` owns its tag outright and so fails on orphans too.

**Only `apply-perf-monitors.sh` PRUNES**, for the same reason. It also compares
QUERIES, not just names: a monitor edited in the Datadog UI keeps its title, and
that is the drift that matters most. **It refuses to prune at all when any row
was REFUSED by its preflight** — a refused row never reaches the rendered set,
so pruning would delete its live monitor, and one transient hour of a vendor
crawl not reporting would destroy a monitor along with its history and mute
state, as the only lasting effect of a run that reports failure.

**SPACE aggregation is chosen per metric, and `max:` is usually wrong for a
total.** Datadog's monitor grammar is `time_aggr(window):space_aggr:metric{…}`,
so the SECOND aggregator is the one that combines series.
`gcp.run.container.instance_count` carries a `state` tag (active / idle), so
`max:` reads max(active, idle) rather than the instance count — a service at its
cap of 20 as 12 active + 8 idle evaluates to 12 and never crosses a `> 18`
critical. It can only ever UNDER-report, so the failure mode is a silent miss.
Counts and totals use `sum:`; an AGE (`oldest_unacked_message_age`) genuinely
wants `max:`, because the oldest message is the question.

**AN ABSENCE ROW CARRIES A KIND, AND IT DECIDES WHICH QUESTION IS ASKED**
(MONEY-1399). Rows in `ABSENCE_MONITORS` are `job|window|kind|cadence`.
`standing` sums `selected`, so a run that selected nothing reads as a fault —
which is the point for a standing population, because a gate matching none of
its rows IS the defect (news-sync: 782 rows selecting nothing for months,
MONEY-1215). `sparse` counts SUBMISSIONS (`count_not_null`), so only silence
alarms — which is the point for a job that CHECKPOINTS or gates on novelty,
where a caught-up run honestly reporting `selected: 0` is health. Checkpointing
predicted the split perfectly across all 25 rows.

**Datadog already separates the two states and the standing query throws it
away.** Measured 2026-09-13: `edgar-bulk-ftd`'s 2026-09-10 run left ONE non-null
point of value `0.0`, while a job that did not run has NO SERIES at all;
`default_zero()` fills the gaps with zeros and makes them identical. That
monitor was created 2026-09-06, alerted 11 seconds later, and had never once
been OK while `us_cusip_map.SEC_FTD` filled correctly underneath it. Keep
`default_zero()` in BOTH forms: `count_not_null` alone returns NO SERIES on a
silent window, so the threshold would never evaluate and the monitor would sit
grey instead of alerting. And both templates must render the SAME `name` — the
upsert is by name, so a drifted name creates a second monitor instead of
updating the first.

**A PREFLIGHT MUST NEVER NAME A SERIES WHOSE EMPTINESS IS HEALTH.** Three rows
would otherwise refuse themselves on a healthy estate, and the dead-letter one
is the sharpest: measured 2026-09-11, `dead_letter_message_count` on a
subscription with no dead letters returns **no series at all** — it is not a
gauge reporting 0, it does not exist until something is parked. Each of those
rows preflights a sibling series that proves the CRAWL is alive instead (the
failure ratio preflights its denominator, dead-letter and the scheduler row
preflight the un-sliced series).

**`gcp.run.request_latency.*` IS IN MILLISECONDS.** 540 seconds is written
`540000`. Measured 2026-09-11: last-hour p95 on `stockbook-workers-prod` was
93,695 (≈94 s). `oldest_unacked_message_age` is in SECONDS, against the same
600 s deadline — so the two families' thresholds differ by 1000x for the same
wall-clock meaning, and a test fails any latency threshold under 100000.

**The Gemini REQUESTS quota is INT64_MAX — unlimited — so it is deliberately
NOT monitored.** `usage / limit` against 9223372036854775807 can never cross a
threshold: a monitor that is green forever, which is the MONEY-1238 defect
wearing a different hat. `generate_content_paid_tier_3_input_token_count.limit`
is 20,000,000/min and IS the ceiling; that is the row that ships.

**Cloud Scheduler emits no Cloud Monitoring metric, but its FAILURES are still
monitorable.** The executions log arrives through the integration as
`gcp.logging.log_entry_count` tagged `log:cloudscheduler.googleapis.com/executions`,
`severity` and `job_id` — 5,050 INFO entries in six hours, so the series is
alive and the `severity:error` slice is the alarm. No log forwarding is needed,
and the note that used to say nothing could see scheduler failures was wrong.
The row preflights the UN-SLICED series for the reason the next paragraph gives.

**A RATIO preflights its DENOMINATOR only.** Preflighting the numerator of the
Pub/Sub failure rate would refuse that row in exactly the state it exists to
detect the end of — no 5xx anywhere is the HEALTHY estate, and a healthy estate
must not be a reason to skip creating the alarm that watches for an unhealthy
one. The Gemini row preflights both sides, because those are quota GAUGES that
report whether or not anything is calling the model.

**`remote_server_4xx` is NOT in the failure numerator.** Those are our own
`pubsubDedupeMiddleware` answering 409 `RETRY_LATER` to a redelivery whose claim
is still live — the dedupe working. Counting them would put a permanent floor
under the ratio and force the threshold up past the signal.

**A monitor message may not carry a bare `{{value}}`.** `dd_render`'s final
guard re-scans the whole rendered body for `/\{\{\w+\}\}/`, so a single-word
Datadog template variable arriving inside a message VALUE still trips it and the
render dies with "unsubstituted placeholders". Dotted ones
(`{{subscription_id.name}}`) are safe — `\w+` cannot cross a `.` — so group
variables are fine and the threshold goes in prose.

**The DATABASE is monitored by an agent on a VM, not by any of those.**
`setup-dbm-host.sh` (MONEY-1377) provisions `usemoney-prod-datadog-agent` —
a dedicated, deletion-protected e2-small in `asia-south1-a` on the reserved IP
`8.231.90.169` — and points the `mongo` check at the prod Atlas replica set
with `dbm: true`. **One instance block per replica member.** The agent reports
rates by delta-ing monotonic counters between collections, so a block naming
the SRV name (or all three members at once) makes it subtract one node's
counter from another's: the check stays green and every rate is fiction. It is
a dedicated VM because tying database monitoring to another workload's box
means the monitoring dies, silently, when that workload is retired.

**Atlas needs no role change.** Measured 2026-09-06 against the live cluster:
`clusterMonitor@admin` + `readAnyDatabase@admin` already authorises every
command DBM issues, including `local.oplog.rs` — `readAnyDatabase` excludes
`local`, but Atlas's `clusterMonitor` reaches it, which Datadog's own docs do
not state either way.

**Both `0 qa` numbers are a switch, not a deletion.** `DD_QA_MONITORING`
gates every QA apply (`dd_qa_monitoring_enabled` in `lib-datadog.sh`): unset,
the scripts print "qa monitoring is disabled — nothing applied" and exit 0.
**And a monitor SLO holds at most 20 `monitor_ids`** — Datadog answers 400
above that, which is why the zero-write and job-absence SLOs name 16 of 40 and
11 of 24 monitors rather than matching a pattern. Each states its coverage in
its `description`, and `slos-agreement.test.ts` re-derives both numbers from
the rendered estate so the caveat cannot go stale (MONEY-1229).

`scripts/ops/datadog/lib-datadog.sh` is the shared transport. **Every service
monitor preflights its own series before it is created**, because these read
series this repo does not emit (`trace.*` from dd-trace, log events from the
intake, RUM from the browser SDK) and a monitor over a series nobody produces
sits in NO DATA forever — indistinguishable from health the moment somebody
mutes it. That single defect class is MONEY-1238, and this repo has now shipped
it at four layers: wrong metric name, wrong env tag, no transport, and a window
shorter than the cron's own weekend gap.

---

## Job throughput — the 600s ceiling nobody wrote down

Every worker job arrives over a Pub/Sub **push** subscription with a **600s ack
deadline**, which is Pub/Sub's maximum. Cloud Run's own request timeout is
3600s, so it is never the binding constraint — the ack deadline always is.

A handler that runs past 600s is not merely slow. Pub/Sub treats the message as
unacked and **redelivers it**, so a second copy of the same job starts
concurrently, doubling the work and potentially looping (`minimumBackoff` is
10s). That is why every batch size in this repo is what it is:

**The two Databento entry points (MONEY-1373) are outside this entirely.** They
are Cloud Run JOBS, not Pub/Sub handlers, so there is no ack deadline to
overrun and no redelivery to guard against — the bound is the task timeout,
24 h for `databento-harvest` and 2 h for `databento-append`. That is the
mechanism this section's last row already points at: making the unit of work
match the unit of delivery, taken one step further by having no delivery at
all. A killed task resumes from the inventory rather than from a checkpoint.

**A lake job that ENDS WITHOUT COMPLETING exits 3** (`guardCompletion`,
MONEY-1608): an awaited promise holds no handle, so when nothing else kept the
event loop alive `lake-replay-us` exited 0 after 8 hours with 0 months loaded.
The GCS SDK never retries an upload without a generation precondition
(`maxRetries` 0), so stage uploads carry their own deadline and retries. Long
lake loads run as Cloud Run jobs (`lake-writer@`), never on a laptop: Workspace
re-auth (`invalid_rapt`) killed every local run twice on 2026-09-23
(MONEY-1609).

A coverage refusal is a MONTH's verdict, not the run's (MONEY-1612): the month
is REJECTED, its missing dates quarantined, and the replay continues, failing at
the end. NSE's `sec_bhavdata_full` archive holds the PREVIOUS session's file on
holidays. A zero-row file counts as a holiday only when it is BYTE-IDENTICAL
(md5, else crc32c) to the file under the held date's own key — an earlier
weekday — AND the NSE bhavcopy for its key date is absent. The date rule alone
was wrong twice on prod: four files are the ONLY copy of a weekend session
(2019-10-28, 2020-11-16, 2024-01-22, 2024-05-20), and 05112021 is the only copy
of the WEEKDAY 2021-11-04 Muhurat session. Those five months correctly refuse
until weekend/Muhurat sessions are loaded under their own date (MONEY-1613).

| Job                             | Batch | Measured           | Headroom                    |
| ------------------------------- | ----- | ------------------ | --------------------------- |
| `financial-data-sync` (retired) | 100   | ~50s               | large                       |
| `mf-metadata-sync`              | 500   | ~490s              | **~18%** — near the ceiling |
| `xbrl-projection`               | 500   | pure DB+arithmetic | large                       |
| `xbrl-ratios`                   | 1000  | pure DB+arithmetic | large                       |
| `stock-document-extract`        | 500\* | 420s WALL CLOCK    | 180s — see below            |
| `stock-document-ingest`         | **1** | ~1s conversion     | the ceiling stops binding   |
| `stock-document-embed`          | 200   | **1,200–3,600s**   | **NEGATIVE — MONEY-1389**   |

**`stock-document-embed` is the row that proves this section is not academic.**
Measured 2026-09-11: **423 requests over 600s in 7 days**, four killed at the
3,600s Cloud Run timeout, `instance_count` pinned at maxScale 20 with 11
requests queued behind it. It takes 200 DOCUMENTS per message, each costing a
chunk pass plus an embedding call plus a 1s sleep, and — alone among the
document-pipeline processors — it has **no `RUN_TIME_BUDGET_MS`, no self-chain
and no in-flight claim**. `stock-document-extract` has all three.

**What an overrun actually costs is worse than "slow", because our own dedupe
converts it into a false alarm.** At 600s Pub/Sub redelivers; `pubsubDedupeMiddleware`
holds a 60-minute lease per messageId and correctly answers the redelivery
**409 `RETRY_LATER`** rather than running it twice — but Pub/Sub counts those
409s as delivery attempts, so after `MAX_DELIVERY_ATTEMPTS=5` (~20-25 minutes
in) the message is DEAD-LETTERED and the founder is notified, **while the
original execution is still running and will succeed**. 368 of those a day from
this one subscription. The fix is MONEY-1389; the notification half is
MONEY-1390.

\* MONEY-1255 — **that 500 is a page size, not the control.** This is the one
row where a batch could never have expressed the constraint: per-document cost
is a Document AI round trip plus a GCS read plus a pdf-parse fallback, and only
the last is ours. It is bounded by `RUN_TIME_BUDGET_MS = 420_000` checked
BETWEEN documents, so the true wall is `budget + one document` and the 180s
headroom is sized for one pathological document (~60s) plus the query and the
publish. Same 420s as `mf-nav-backfill`; lower than `xbrl-sync`'s 480s because
that job's per-item cost is a fixed 600 ms delay plus one download, so its
overshoot is small, while a Document AI call carries no client-side timeout at
all. The job then SELF-CHAINS up to `MAX_CHAIN_DEPTH = 20` follow-ups, which is
the lever this section already recommended and the first job in the repo to use
it. Its scheduler payload is deliberately `{}` — pinning a batch here would be a
second copy of a constant in the worker, and this file cannot fail when the two
drift.

**MONEY-1314 — the other way out is to make the batch ONE.**
`stock-document-ingest` takes a single document per message, and that dissolves
the constraint rather than tuning against it. The page-per-message lane it
replaces needed three mechanisms _because_ the unit of work was larger than the
unit of delivery: `RUN_TIME_BUDGET_MS` (a wall clock inside the ack deadline, so
a page can stop part-way), `MAX_CHAIN_DEPTH` (a self-chain to reach the rest of
the queue), and `PARSE_SCAN_CAP` (a ceiling on how much of the table one
selection may consider — already breached at 48,322 against 40,000). With one
document per message the 600s deadline bounds ONE document, which needs a
fraction of it: the slowest conversion measured is 980 ms for a 311-page annual
report. No page to truncate, no remainder to chain, no scan to cap; Pub/Sub's
own concurrency replaces all three. The cost is that the HISTORICAL corpus can
no longer ride the same lane — it is drained by a Cloud Run job, which has no
ack deadline at all.

**RE-MEASURED 2026-09-05 (MONEY-1337), and the drain had STALLED.** The
conversion pass converted ~34,000 documents on 1-2 September and then died
twice with "The configured memory limit was reached"; nothing converted or
parsed after that. 48,092 documents remain unconverted and 50,801 unparsed.
Two things the original sizing missed, both structural rather than bad luck:

- **Serial conversion is the wall, not memory.** Measured 1.6 s/document
  (13,570 in a 6 h run), almost all of it waiting on GCS and Mongo. 8Gi stops
  the OOM; FOUR sharded Cloud Run tasks x four documents in flight is what
  takes ~21 h down to ~1.5-3 h. The converter's OOM ceiling must be divided PER
  SLOT, or four documents each sized against the whole container reproduce the
  kill the memory bump was meant to end.
- **`fetchedAt` ASC leaves the newest cohort last.** 0 of 30,959 quarterly
  results are converted, because 27,170 of them arrived on 27-28 August and sit
  at the end of the queue. Nothing is wrong with the ordering; it is worth
  knowing before reading any docType-level coverage number.

And the parse gate's own numbers: of 1,885 rejected extract rows, **1,821
(96.6%) are UNKNOWN_SCALE**, 1,804 as the sole reason. One rule, not a long
tail — a fact that took an aggregation over nested JSON to see, which is why
those reasons are columns now.

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
  681 of 781 symbols). **`desc` is the same defect on a GROWING population**
  (MONEY-1255): `stock-document-extract` selected `fetchedAt: "desc"`, 50 a
  night, against a queue the weekly sync adds thousands to — so newest-first did
  not delay the oldest rows, it pushed them further down every cycle and never
  reached them. 36,001 PENDING documents, ~2 years to drain at that rate even
  with no new arrivals.
- **An EXACT match against a column written from a RESPONSE HEADER will miss.**
  A `content-type` is a media type plus PARAMETERS, so `mimeType: { in:
["application/pdf"] }` never matched the `application/pdf;charset=UTF-8` rows
  the same job stored. It hid because the sibling function that named the GCS
  object used a SUBSTRING test, so the FILE was right while the row was
  unreachable. One rule, stated twice, disagreeing (MONEY-1255: 1,211 rows).

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

## Claude Code Automation (Loops & Verification)

The dev workflow encodes its quality gates as deterministic loops — skills,
scripts, and hooks — instead of per-session memory.

### Verification gate (before every push)

```bash
yarn verify:push                 # yarn build + yarn test --force → .claude/.verify-ok
VERIFY_SERIAL=1 yarn verify:push # serialized fallback for parallel TASK-level flakes
```

On success it writes a gitignored marker keyed to a content hash of the exact
tree it verified (commit/staging changes keep it valid; any file edit
invalidates it). `.claude/hooks/pre-push-gate.sh` is the PreToolUse hook that
blocks Claude's `git push` without a fresh marker (registered in
`.claude/settings.json`; emergency bypass: `VERIFY_GATE_BYPASS=1 git push …`,
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
      THIRTEEN AMCs, not "3 of the top-5" as this said for three releases —
      measured 2026-08-30: 30,501 rows, 563 schemes, NIPPON/MIRAE/SBI/HDFC/
      GROWW/BARODA_BNP/PPFAS/ZERODHA/SHRIRAM/HELIOS/OLD_BRIDGE/CAPITALMIND/DSP.
      ABSL, Kotak and ICICI Prudential ARE fetched as of MONEY-1405 (each
      verified by one real fetch of the current month, 104 / 119 / 147 sheets);
      UTI is resolved and still BLOCKED, on a parser feature rather than a URL
      — its consolidated zip holds every scheme end to end in ONE sheet,
      delimited by `SCHEME CODE<nnn>STARTS`, and ingesting it as-is would merge
      ~100 schemes into one portfolio. Coverage is 17 of AMFI's 57 registered
      AMCs; read it off `resolverCoverage`, which the nightly job logs, rather
      than off this line. Nippon keeps only the CURRENT month, so its schedule
      carries the risk rather than its parser. The REAL gap is history, not
      breadth — every row is period 2026-07-01, so 563 of 14,225 funds have
      exactly one month (MONEY-1295), and `amfiSchemeCode` was set on 861 of
      30,501 rows, which left the join to `mutual_fund_masters` effectively
      dead (MONEY-1294). MONEY-1404's second resolver lifts that from 11
      distinct codes to 142 on the next monthly run — measured against prod
      with the shipped functions — but 435 of the 436 remaining ambiguities are
      ONE portfolio behind AMFI's Direct/Regular x Growth/IDCW plan split, four
      codes for one set of holdings, which a single `amfiSchemeCode` column
      cannot represent. That is a schema question, not a matching one. - **P11 circulars + Market Pulse** (MONEY-1187) — `circNumber` is NOT
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

> **`--test-timeout` IS A PER-FILE WALL-CLOCK BUDGET, AND IT COVERS MODULE
> LOAD** (MONEY-1489). It is documented per-TEST and node treats each FILE as a
> test, so the 30,000 ms applies to the whole child process. Measured, not
> inferred: a file that burns 5 s at MODULE SCOPE is cancelled by
> `--test-timeout=3000` exactly like one that burns it inside `it()`. So
> "hoist the expensive `require()` out of the measured suite" moves the cost
> within the same budget and buys nothing — only making it CHEAPER helps.
>
> A file that blows the budget is CANCELLED: its cases vanish from every
> counter and `# fail` stays **0** (run #729: `# tests 20858`, `# fail 0`,
> `# cancelled 2`, 122 cases gone). Node exits 1, so CI went red — three times,
> all undiagnosed, because the annotation read `Process completed with exit
code 1` with no filename. `scripts/test-timeout.ts` now NAMES the cancelled
> files. It wraps every workspace's `node --test`, so it covers CI and
> `yarn verify:push` alike, and it sits BELOW turbo — which matters, because
> turbo prefixes every line in a multi-workspace run, so a `^not ok` grep in
> the workflow would be blind there (the pattern would have to be
> `:test: *not ok`).
>
> **The usual cause is a ROOT BARREL import.** A cold
> `require("@usemoney/services")` costs **3817 ms** — it re-exports ~40
> services and drags in the research, roast and PDF-renderer packages — where
> the subpath a test actually needs costs **48 ms**. `coupon.test.ts` went
> 3243 ms → 238 ms on one line. The standing "import subpaths, never root
> barrels" rule is a test-budget rule too.
>
> That fix does NOT generalise to a test whose expensive `require` is the
> module UNDER TEST: narrowing `lib/actions/broker-connection.ts` to subpaths
> bought 8% and broke 9 tests, because the broker suites seam the services
> layer by purging `packages/services/src/index.` from `require.cache` and a
> subpath never passes through `index.ts`. Reverted — see TEST-COVERAGE.md.
>
> **And the EXECUTED case count is gated now**, per workspace invocation, in
> `scripts/test-case-floors.json`. It sees the sibling class: cases that were
> never REGISTERED exit **0** with every counter green. It counts
> `pass + skipped`, not `# pass`, so an environment-gated CASE that skips does
> not turn the gate red. It complements `yarn test:coverage-check`, which reads
> the on-disk FILE inventory and never looks at what ran.
>
> **IT DOES NOT CATCH MONEY-1093 ITSELF, and an earlier draft of this note
> claimed it did.** Review measured the difference. MONEY-1093's mechanism is
> an UNQUOTED glob, and after the shell expands one the trailing argument is a
> concrete PATH — so the wrapper takes its file-list branch, looks up no floor
> at all, and prints `floor n/a — file-list run`. Measured on a 7-case fixture
> with a floor of 7: quoted-with-a-file-missing exits 1; unquoted drops 4 of 7
> cases and exits **0**.
>
> So the floor covers "the glob was right and cases still vanished", and
> `packages/core/__tests__/ops/test-glob-quoting.test.ts` covers the glob being
> wrong — asserting every one of the 21 workspace scripts quotes it, which the
> pre-existing pin did for `packages/core` alone and therefore never for
> `apps/web`, where MONEY-1093 actually bit. Two different failures; neither
> guard substitutes for the other.

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
6. Update relevant CLAUDE.md files
7. Run the verification gate (`yarn verify:push`) and a fresh-context review
   (`/code-review`; money paths → `/code-review ultra`) — this repo has no
   human reviewer
8. Create PR with clear description - the PR template auto-populates
9. PRs require approval before merge (owner `deepshaswat@gmail.com` is exempt)

---

_Last Updated: August 2026_
