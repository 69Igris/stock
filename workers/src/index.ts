/**
 * UseMoney Workers - HTTP Service
 *
 * Receives Pub/Sub push messages for background job processing:
 * - Trade pairing (FIFO algorithm)
 * - CSV/XLS import
 * - Broker data sync
 *
 * Deployed as a GCP Cloud Run Service (not Jobs).
 */

// MONEY-1209: console redaction. This import is deliberately ABOVE the tracer.
//
// ESM evaluates module bodies in import order, so putting `./log-boundary`
// first does NOT displace dd-trace: the rule dd-trace actually needs is that
// `initTracer()` runs before the modules it patches (http, prisma, ioredis) are
// loaded, and `log-boundary` pulls in exactly one dependency-free file
// (`@usemoney/utils/log-redaction`) which imports nothing patchable. What this
// ordering buys is the startup window — a failed import, a module-level side
// effect, a credentialed request that dies during boot — which is precisely the
// window where an error object still has its headers attached.
import { installLogRedaction } from "./log-boundary";
installLogRedaction();

// Datadog tracer - MUST be imported before all other application code
// so dd-trace can patch HTTP, Prisma, ioredis, etc. at load time.
import { initTracer, flushMetrics } from "@usemoney/datadog";
initTracer({ service: "stockbook-workers" });

// Force IPv4 DNS resolution - Cloud Run's default resolver tries IPv6 first,
// which causes timeouts when external APIs (Kuvera, Yahoo) don't route IPv6
// properly from GCP's network.
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

// Load environment variables (supports .env and .env.local)
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// Load monorepo root .env (has broker API keys), then local overrides
const monorepoRoot = path.resolve(rootDir, "..");
dotenv.config({ path: path.join(monorepoRoot, ".env") });
dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });

import { initLogger } from "@usemoney/logger";

// Initialize logger with Datadog multistream (if DD_API_KEY is set)
await initLogger();

// MONEY-1375 — and attaching the stream is only half of it. Almost nothing in
// this process writes to pino (~573 `console.*` against 3 `getLogger()` uses,
// and `reportJobOutcome` is a `console.log`), so without this the stream is
// attached and fed nothing. Measured in prod after the first deploy: ten job
// types reported metrics in two hours and `service:stockbook-workers` had ZERO
// logs. Must come after `initLogger()` — it forwards into the root logger.
import { forwardConsoleToDatadog } from "./lib/job-telemetry";
forwardConsoleToDatadog();

// MONEY-1085: register the GCS raw-feed archive. No-op unless
// FEED_ARCHIVE_MODE is set, so this cannot affect an env that hasn't opted in.
// Must run before any ingest job so bhavcopy / instrument-sync see the store.
import { initFeedArchive } from "./lib/feed-archive-store";
initFeedArchive();

// MONEY-980: register the GCS candle cold store. Must run before us-eod-sync or
// any candle write, because `putCandles` routes pre-window and delisted bars to
// a GCS shard and `writeColdShard` THROWS without a registered store. Warns and
// stays off when GCP_STORAGE_BUCKET is unset — see the module header for why
// that is a hard gate here and only a soft one for the feed archive.
import { initCandleColdStore } from "./lib/candle-cold-store-gcs";
initCandleColdStore();

// MONEY-979: register the GCS 13F cold store. The research tools reach
// `@usemoney/core/us-fundamentals` from THIS process, and without a
// registration every read of an EVICTED quarter answers `absent` — which
// renders as a manager who sold everything. Read-only: the shards are written
// by the Python evictor, never from here. Warns and stays off when
// GCP_STORAGE_BUCKET is unset, which core reports as
// COLD_STORE_NOT_REGISTERED rather than as an empty portfolio.
import { initUsColdStore } from "./lib/us-cold-store-gcs";
initUsColdStore();

// MONEY-1169 canary: log which node-fetch the GCS SDK's transport resolves.
// The Docker image used to overlay workers/node_modules onto the root
// node_modules, silently swapping node-fetch@3 (gcp-metadata's nested copy)
// under transports written against v2 — which corrupted every uploaded object
// for ~3 months. The Dockerfile now preserves yarn's layout; this line makes
// that verifiable from the boot log of every deploy. A path containing
// "workers/node_modules" here means the overlay regressed.
import { createRequire } from "node:module";
try {
  const req = createRequire(import.meta.url);
  const transportFetch = createRequire(req.resolve("teeny-request")).resolve(
    "node-fetch",
  );
  const regressed = transportFetch.includes("workers/node_modules");
  console[regressed ? "error" : "log"](
    `[MONEY-1169] storage transport resolves node-fetch at: ${transportFetch}` +
      (regressed
        ? " — OVERLAY REGRESSION: this is the v3 copy; uploads will corrupt or fail"
        : ""),
  );
} catch {
  // Transport layout changed (SDK upgrade) — the canary is best-effort.
}

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { OAuth2Client } from "google-auth-library";
import { healthRoute } from "./routes/health";
import { pairingRoute } from "./routes/pairing";
import { importRoute } from "./routes/import";
import { syncRoute } from "./routes/sync";
import { instrumentSyncRoute } from "./routes/instrument-sync";
import { priceSyncRoute } from "./routes/price-sync";
import { intradaySyncRoute } from "./routes/intraday-sync";
import { sectorEnrichmentRoute } from "./routes/sector-enrichment";
import { mfSyncRoute } from "./routes/mf-sync";
import { mfMetadataSyncRoute } from "./routes/mf-metadata-sync";
import { mfNavPropagateRoute } from "./routes/mf-nav-propagate";
import { mfNavBackfillRoute } from "./routes/mf-nav-backfill";
import { peersSyncRoute } from "./routes/peers-sync";
import { researchRoute } from "./routes/research";
import { documentProcessRoute } from "./routes/document-process";
import { studioRenderRoute } from "./routes/studio-render";
import { roastRoute } from "./routes/roast";
import { comparisonRoute } from "./routes/comparison";
import { indexConstituentSyncRoute } from "./routes/index-constituent-sync";
import { surveillanceSyncRoute } from "./routes/surveillance-sync";
import { institutionalFlowSyncRoute } from "./routes/institutional-flow-sync";
import { marketMoversSyncRoute } from "./routes/market-movers-sync";
import { xbrlSyncRoute } from "./routes/xbrl-sync";
import { xbrlProjectionRoute } from "./routes/xbrl-projection";
import { xbrlRatiosRoute } from "./routes/xbrl-ratios";
import { circularsSyncRoute } from "./routes/circulars-sync";
import { mfPortfolioSyncRoute } from "./routes/mf-portfolio-sync";
import { macroSyncRoute } from "./routes/macro-sync";
import { newsletterPublishRoute } from "./routes/newsletter-publish";
import { l3AnalysisRoute } from "./routes/l3-analysis";
import { loginBriefingRoute } from "./routes/login-briefing";
import { accountDeletionRoute } from "./routes/account-deletion";
import { clerkDeleteSweepRoute } from "./routes/clerk-delete-sweep";
import { financialDataSyncRoute } from "./routes/financial-data-sync";
import { newsSyncRoute } from "./routes/news-sync";
import { newsRssSyncRoute } from "./routes/news-rss-sync";
import { eventsSyncRoute } from "./routes/events-sync";
import { alertEvaluatorRoute } from "./routes/alert-evaluator";
import { strategyStatsSyncRoute } from "./routes/strategy-stats-sync";
import { filingsSyncRoute } from "./routes/filings-sync";
import { chartinkStrategySyncRoute } from "./routes/chartink-strategy-sync";
import { intentLearningRoute } from "./routes/intent-learning";
import { strategyScanRoute } from "./routes/strategy-scan";
import { stockDocumentSyncRoute } from "./routes/stock-document-sync";
import { stockDocumentExtractRoute } from "./routes/stock-document-extract";
import { stockDocumentEmbedRoute } from "./routes/stock-document-embed";
import { stockDocumentParseRoute } from "./routes/stock-document-parse";
import { stockDocumentIngestRoute } from "./routes/stock-document-ingest";
import { documentFinancialsProjectionRoute } from "./routes/document-financials-projection";
import { corporateActionsRoute } from "./routes/corporate-actions";
import { resendContactSyncRoute } from "./routes/resend-contact-sync";
import { sparklineSyncRoute } from "./routes/sparkline-sync";
import { etfExpenseEnrichmentRoute } from "./routes/etf-expense-enrichment";
import { previewPlanRoute } from "./routes/preview-plan";
import { investorRollupRoute } from "./routes/investor-rollup";
import { bhavcopySyncRoute } from "./routes/bhavcopy";
// MONEY-980 - nightly Tiingo US price backbone (EOD + NAV + derived corp
// actions + USDINR). Four counted legs, one upstream, one rate-limit budget.
import { usEodSyncRoute } from "./routes/us-eod-sync";
import { candleEvictRoute } from "./routes/candle-evict";
import { tiingoNewsPollRoute } from "./routes/tiingo-news-poll";
// MONEY-1324 (P17) - AI readings of SEC 8-K/6-K exhibits. ONE ROUTE, TWO
// MESSAGE SHAPES: {"mode":"sweep"} fans out, {"documentId":...} analyses one.
import { usFilingInsightRoute } from "./routes/us-filing-insight";
import { internalEventsRoute } from "./routes/internal-events";
import { usInstrumentMasterSyncRoute } from "./routes/us-instrument-master-sync";
import { reportArchiveSyncRoute } from "./routes/report-archive-sync";
import { bseAnnouncementsRoute } from "./routes/bse-announcements";
import { nseAnnouncementsRoute } from "./routes/nse-announcements";
import { ownershipSyncRoute } from "./routes/ownership-sync";
import { annualReportsSyncRoute } from "./routes/annual-reports-sync";
import { ipoSyncRoute } from "./routes/ipo-sync";
// MONEY-1204 - consumer for `dead-letter-${ENV}` (the DLQ has existed since
// MONEY-841 with nothing subscribed to it)
import { deadLetterRoute } from "./routes/dead-letter";
import { pubsubDedupeMiddleware } from "./lib/pubsub-dedupe";
import type { DedupeContext } from "./lib/pubsub-dedupe-logic";
import {
  startPullSubscribers,
  stopPullSubscribers,
} from "./lib/pull-subscriber";
import { auditDatabaseIndexes } from "@usemoney/core/database/index-guard";
import { formatIndexAudit } from "@usemoney/core/database/index-guard-logic";
import { shouldEnablePullSubscriber } from "./index-logic";
import {
  createJobsAuthMiddleware,
  type JobsAuthContext,
} from "./index-auth-logic";

const app = new Hono();

// Pub/Sub OIDC token verification middleware for job endpoints.
//
// MONEY-288 (security audit): verification was previously gated behind
// `NODE_ENV === "production"`, so QA Cloud Run accepted UNAUTHENTICATED POSTs to
// every /jobs/* route — anyone hitting the QA URL could trigger any of the 35
// processors with an arbitrary payload. It is now ALWAYS on for any deployed
// environment (push subscriptions always carry an OIDC token), with a single
// explicit opt-out for genuine local development, where Pub/Sub can't reach
// localhost and jobs arrive via the pull subscriber (no HTTP auth context).
const oidcClient = new OAuth2Client();
// Skip HTTP OIDC ONLY in true local dev: not production/qa AND the local pull
// subscriber path is active. Never skips on a deployed (production|qa) worker.
// The decision lives in `index-auth-logic.ts` so it can be tested against the
// REAL implementation — the previous test re-declared this middleware inline, so
// a fail-open regression here would not have turned it red.
const jobsAuth = createJobsAuthMiddleware({
  nodeEnv: process.env.NODE_ENV,
  enablePullSubscriber: process.env.ENABLE_PULL_SUBSCRIBER,
  audience: process.env.CLOUD_RUN_URL,
  verifyIdToken: (args) => oidcClient.verifyIdToken(args),
  logError: (message, err) =>
    err === undefined ? console.error(message) : console.error(message, err),
});
app.use("/jobs/*", (c, next) =>
  jobsAuth(c as unknown as JobsAuthContext, next),
);

// MONEY-1507 (C1) — the SAME gate on `/internal/*`. Hono's `app.use` matches by
// prefix, so `/jobs/*` does not cover it, and reusing the factory rather than
// copying the decision is the point of it being a factory: the deny-by-default
// rule lives in ONE place (MONEY-288).
//
// MONEY-1520 — THERE IS NO `/internal/*` ROUTE ANY MORE. `POST /internal/events`
// moved to `/jobs/us-filing-events` when its producer moved to Pub/Sub, so this
// registration currently guards nothing. It is kept rather than deleted, and
// that is a decision: the route it used to cover WRITES to `instrument_events`,
// which C4's alert evaluator reads, so an unauthenticated writer there could
// notify every user holding a stock — the risk the comment above names. A
// standing deny on the prefix costs one middleware registration and means the
// next `/internal/…` route is gated from its first commit instead of from the
// review that notices.
app.use("/internal/*", (c, next) =>
  jobsAuth(c as unknown as JobsAuthContext, next),
);

// MONEY-1204: Pub/Sub messageId idempotency, universal across /jobs/*.
//
// Pub/Sub is at-least-once and this service has ~55 job routes; before this,
// every ack-deadline overrun (600s), instance restart and 5xx re-ran the whole
// job. Registered AFTER the OIDC gate deliberately — claiming a messageId for
// an unauthenticated request would let anyone burn the dedupe key for a real
// message, a denial-of-job with no credentials required.
//
// The middleware is a no-op for bodies without a genuine Pub/Sub messageId
// (local dev, manual curl, the pull subscriber), and fails OPEN if the dedupe
// store is unreachable: a Mongo blip must not become a total job outage.
app.use("/jobs/*", (c, next) =>
  pubsubDedupeMiddleware(c as unknown as DedupeContext, next),
);

// Routes
app.route("/health", healthRoute);
app.route("/jobs/trade-pairing", pairingRoute);
app.route("/jobs/csv-import", importRoute);
app.route("/jobs/broker-sync", syncRoute);
app.route("/jobs/instrument-sync", instrumentSyncRoute);
app.route("/jobs/price-sync", priceSyncRoute);
app.route("/jobs/intraday-sync", intradaySyncRoute);
app.route("/jobs/sector-enrichment", sectorEnrichmentRoute);
app.route("/jobs/mf-sync", mfSyncRoute);
app.route("/jobs/mf-metadata-sync", mfMetadataSyncRoute);
app.route("/jobs/mf-nav-propagate", mfNavPropagateRoute);
app.route("/jobs/mf-nav-backfill", mfNavBackfillRoute);
app.route("/jobs/peers-sync", peersSyncRoute);
app.route("/jobs/stock-research", researchRoute);
app.route("/jobs/document-process", documentProcessRoute);
app.route("/jobs/studio-render", studioRenderRoute);
app.route("/jobs/portfolio-roast", roastRoute);
// MONEY-553 - async deep stock/MF comparison
app.route("/jobs/comparison-analysis", comparisonRoute);
app.route("/jobs/index-constituent-sync", indexConstituentSyncRoute);
app.route("/jobs/surveillance-sync", surveillanceSyncRoute);
// MONEY-1108 P8d - daily FII/DII institutional cash-market flows
app.route("/jobs/institutional-flow-sync", institutionalFlowSyncRoute);
// MONEY-1198 - the EXCHANGE'S OWN top gainers/losers + live index snapshot,
// polled intraday. Whole-market only (3 requests per poll, no per-symbol
// fan-out); gated on live market hours at runtime.
app.route("/jobs/market-movers-sync", marketMoversSyncRoute);
// MONEY-1113 P10 F1 - company financials from NSE's own XBRL
app.route("/jobs/xbrl-sync", xbrlSyncRoute);
app.route("/jobs/xbrl-projection", xbrlProjectionRoute);
app.route("/jobs/xbrl-ratios", xbrlRatiosRoute);
// MONEY-1187 P11 - NSE exchange circulars
app.route("/jobs/circulars-sync", circularsSyncRoute);
// MONEY-1105 P8a - AMC monthly portfolio disclosures
app.route("/jobs/mf-portfolio-sync", mfPortfolioSyncRoute);
app.route("/jobs/macro-sync", macroSyncRoute);
app.route("/jobs/newsletter-publish", newsletterPublishRoute);
app.route("/jobs/l3-analysis", l3AnalysisRoute);
app.route("/jobs/login-briefing", loginBriefingRoute);
// MONEY-391 - async account deletion (Clerk lock + snapshot + Dodo cancel + DB cascade + email)
app.route("/jobs/account-deletion", accountDeletionRoute);
// MONEY-144 - hourly sweep that purges Clerk users 24h after lock
app.route("/jobs/clerk-delete-sweep", clerkDeleteSweepRoute);
app.route("/jobs/financial-data-sync", financialDataSyncRoute);
app.route("/jobs/news-sync", newsSyncRoute);
// MONEY-408 - RSS-based news ingestion + alert engine
app.route("/jobs/news-rss-sync", newsRssSyncRoute);
// MONEY-408 - daily earnings-calendar population (UpcomingEvent)
app.route("/jobs/events-sync", eventsSyncRoute);
app.route("/jobs/alert-evaluator", alertEvaluatorRoute);
// MONEY-406 - weekly strategy backtest stats sync
app.route("/jobs/strategy-stats-sync", strategyStatsSyncRoute);
app.route("/jobs/filings-sync", filingsSyncRoute);
app.route("/jobs/chartink-strategy-sync", chartinkStrategySyncRoute);
app.route("/jobs/intent-learning", intentLearningRoute);
app.route("/jobs/strategy-scan", strategyScanRoute);
app.route("/jobs/stock-document-sync", stockDocumentSyncRoute);
// MONEY-783 - Document AI / pdf-parse extraction of PENDING stock PDFs -> embed chain
app.route("/jobs/stock-document-extract", stockDocumentExtractRoute);
app.route("/jobs/stock-document-embed", stockDocumentEmbedRoute);
// MONEY-1255 - Gemini reads filed PDFs into document_financial_extracts
app.route("/jobs/stock-document-parse", stockDocumentParseRoute);
app.route("/jobs/stock-document-ingest", stockDocumentIngestRoute);
// MONEY-1257 — the route file, the topic, the push subscription and the
// scheduler all shipped; only this line was missing, so every delivery 404'd
// and the subscription dead-lettered after 5 attempts. A job can be fully
// provisioned in every other respect and still be unreachable.
app.route(
  "/jobs/document-financials-projection",
  documentFinancialsProjectionRoute,
);
// MONEY-840/844 - weekly corporate-actions ingestion (Screener + NSE -> DB + GCS)
app.route("/jobs/corporate-actions-sync", corporateActionsRoute);
app.route("/jobs/resend-contact-sync", resendContactSyncRoute);
app.route("/jobs/sparkline-sync", sparklineSyncRoute);
app.route("/jobs/etf-expense-enrichment", etfExpenseEnrichmentRoute);
app.route("/jobs/research-preview-plan", previewPlanRoute);
// MONEY-789 (B4) - nightly investor self-learning rollup
app.route("/jobs/investor-rollup", investorRollupRoute);
app.route("/jobs/bhavcopy-sync", bhavcopySyncRoute);
// MONEY-980 - the US price backbone. MONEY-1257 is the reason this line is
// written in the same edit as the import above: `document-financials-projection`
// shipped with its route file, processor, topic, push subscription, scheduler
// job and message type all correct, and ONLY this mount missing — so every
// delivery 404'd and dead-lettered after five attempts while the scheduler
// kept firing on time. The path segment after `/jobs/` MUST equal the topic
// base name (`us-eod-sync`), or the push subscription points at nothing.
app.route("/jobs/us-eod-sync", usEodSyncRoute);
// MONEY-980 — the US master. Runs 10:00 IST, an hour ahead of us-eod-sync at
// 11:00, because that job's population does not exist until this one has
// written it. (Both slots moved when the EOD trigger did: fund NAVs publish
// after 12:00 AM ET, which the old 07:00 IST slot missed by 3.5 hours. The
// scheduler is the source of truth — `us-instrument-master-sync-daily` is
// `0 10 * * 2-6` and `us-eod-sync-daily` is `0 11 * * 2-6`.)
app.route("/jobs/us-instrument-master-sync", usInstrumentMasterSyncRoute);
// MONEY-980 — the hot/cold store's only DELETER: a LOADED row 30 days past its
// last read, and a WINDOW row whose year has rolled out of the hot window.
// Runs 15:00 IST, well clear of us-eod-sync's 11:00 chain (up to 2h20m), so the
// two never contend for `candles`. DISARMED unless CANDLE_EVICT_APPLY=true.
// The path segment after `/jobs/` MUST equal the topic base name
// (`candle-evict`), or the push subscription points at nothing — MONEY-1257,
// where a job shipped with its route file, processor, topic, subscription,
// scheduler entry and message type all correct and ONLY this line missing, so
// every delivery 404'd and dead-lettered while the scheduler fired on time.
app.route("/jobs/candle-evict", candleEvictRoute);
// MONEY-1309 — the 24x7 US news poller, every 2 minutes. It SUPERSEDES leg (f)
// of us-eod-sync, which was retired: that leg rode a Tue-Sat 11:00 IST MARKET
// cron, so it could not run at all on a Sunday or Monday IST and prod measured
// a newest article 88h old with 29.6h mean ingest lag. No counter could show
// that — every run that DID happen fetched its day and reported healthy.
// The path segment after `/jobs/` MUST equal the topic base name
// (`tiingo-news-poll`), or the push subscription points at nothing (MONEY-1257).
// The topic constant, the `*/2 * * * *` PROD_ONLY scheduler row and the push
// subscription all land with this mount — `topic-publisher-coverage` fails a
// declared topic nothing publishes to AND a scheduler entry naming an undeclared
// topic, so the set cannot be half-wired in either order.
app.route("/jobs/tiingo-news-poll", tiingoNewsPollRoute);
// MONEY-1324 (P17) — the 8-K/6-K exhibit insight lane. The path segment after
// `/jobs/` MUST equal the topic base name (`us-filing-insight`), and here it is
// load-bearing TWICE: the push subscription targets it, and the SWEEP publishes
// per-document messages back onto the same topic, so a misrouted mount would
// 404 the scheduler's tick AND everything that tick fanned out.
app.route("/jobs/us-filing-insight", usFilingInsightRoute);
// MONEY-1507 (C1), REMOUNTED BY MONEY-1520. It WAS `/internal/events`, a
// direct cross-service POST, on the reasoning that nothing published to it. It
// answered 404 on every call for as long as it existed: this service carries
// `run.googleapis.com/ingress: internal` and `us-fundamentals-{env}` has no VPC
// egress, so the request left over the public internet and Cloud Run refused it
// AT THE EDGE — never reaching Hono, never reaching `jobsAuth`, which has no
// 404 path and would have answered 401.
//
// Now it consumes `us-filing-events-{env}` on a push subscription, which is not
// external traffic. The path segment MUST equal the topic base name: the
// subscription is built as `${SERVICE_URL}/jobs/${BASE_TOPIC}` and
// route-registration-coverage.test.ts joins the two lists in both directions.
//
// `/jobs/*` also brings `pubsubDedupeMiddleware`, which `/internal/*` did not.
// That is a bonus rather than the reason: `publishEvents` upserts on a
// deterministic `eventId`, so a duplicate delivery is harmless.
//
// CORRECTED (MONEY-1514 review): this used to claim the dedupe also stops a
// redelivery re-stamping `observedAt`. It does NOT. Dedupe skips a duplicate
// of an ACKED message (SKIP_COMPLETED); the 500-NACK retry that `ackStatusFor`
// introduces is granted RUN by `reclaim_after_failure`. What actually stops
// the re-stamp is the route sourcing `observedAt` from the envelope's
// `publishTime`, which is stable across redeliveries.
app.route("/jobs/us-filing-events", internalEventsRoute);
app.route("/jobs/report-archive-sync", reportArchiveSyncRoute);
app.route("/jobs/bse-announcements-sync", bseAnnouncementsRoute);
// MONEY-1098 (P5.1) - whole-market NSE announcements, deduped against the BSE leg
app.route("/jobs/nse-announcements-sync", nseAnnouncementsRoute);
app.route("/jobs/ownership-sync", ownershipSyncRoute);
app.route("/jobs/annual-reports-sync", annualReportsSyncRoute);
app.route("/jobs/ipo-sync", ipoSyncRoute);
// MONEY-1204 - dead-letter consumer. Opted OUT of the dedupe middleware above
// (`SELF_DEDUPING_ROUTES`) because that path answers a competing claim with a
// 409 = nack, and nacking a dead letter grows the one queue with no backstop.
// It runs the same dedupe store itself and acks every outcome.
app.route("/jobs/dead-letter", deadLetterRoute);

const port = parseInt(process.env.PORT || "8081");

// Pull subscriber is for LOCAL development only (push can't reach localhost).
// On Cloud Run (production/qa), Pub/Sub push subscriptions deliver directly.
//
// MONEY-807: the auto-enable now keys off a POSITIVE local signal
// (`NODE_ENV === "development"` OR `PUBSUB_ENV === "local"`) rather than the old
// "NODE_ENV is NOT production|qa" negation. A deployed worker that boots with an
// unset/odd NODE_ENV (e.g. "" or "staging") used to fall through that negation
// and silently auto-CREATE pull subscriptions in a real environment — a
// competing consumer that steals push messages. With the positive signal, only
// a genuinely-local boot auto-enables; the explicit `ENABLE_PULL_SUBSCRIBER`
// flag remains the override for any other local setup. The pure decision lives
// in `index-logic.ts` (unit-tested) so the prod path + test run the SAME code.
const enablePull = shouldEnablePullSubscriber(process.env);

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`
╔════════════════════════════════════════════╗
║       UseMoney Worker Service             ║
╠════════════════════════════════════════════╣
║  Port: ${String(port).padEnd(33)}║
║  Environment: ${(process.env.NODE_ENV || "development").padEnd(27)}║
║  Pull Subscriber: ${(enablePull ? "ENABLED" : "disabled").padEnd(22)}║
║  Endpoints:                                ║
║    GET  /health                            ║
║    POST /jobs/trade-pairing                ║
║    POST /jobs/csv-import                   ║
║    POST /jobs/broker-sync                  ║
║    POST /jobs/instrument-sync              ║
║    POST /jobs/price-sync                   ║
║    POST /jobs/intraday-sync                ║
║    POST /jobs/sector-enrichment            ║
║    POST /jobs/mf-sync                     ║
║    POST /jobs/mf-nav-propagate             ║
║    POST /jobs/mf-nav-backfill              ║
║    POST /jobs/mf-metadata-sync            ║
║    POST /jobs/stock-research               ║
║    POST /jobs/document-process             ║
║    POST /jobs/portfolio-roast              ║
║    POST /jobs/newsletter-publish          ║
║    POST /jobs/l3-analysis                ║
║    POST /jobs/login-briefing             ║
║    POST /jobs/xbrl-projection            ║
║    POST /jobs/xbrl-ratios                ║
║    POST /jobs/news-sync                  ║
║    POST /jobs/filings-sync              ║
║    POST /jobs/chartink-strategy-sync    ║
║    POST /jobs/intent-learning          ║
║    POST /jobs/strategy-scan           ║
╚════════════════════════════════════════════╝
`);

  if (enablePull) {
    startPullSubscribers().catch((err) =>
      console.error("[pull-subscriber] Failed to start:", err),
    );
  }

  // MONEY-1485. Does this environment actually ENFORCE the unique constraints
  // these jobs assume? `putCandles` absorbs a duplicate-key collision
  // correctly and only ever gets one if the index exists; in QA it did not, so
  // every duplicate inserted cleanly and was counted as `created` — a green run
  // writing the rows its own contract forbids, surfaced months later by a
  // developer's local `yarn dev` rather than by anything here.
  //
  // `prisma db push` is the only thing that builds these indexes and it is a
  // DEVELOPER action — it is in `turbo.json` and in hand-run setup scripts, and
  // in no deploy pipeline. So the check has to run somewhere that happens by
  // itself. A script nobody is scheduled to run is the same defect one level
  // up, which is exactly how the `TIINGO/ws/` rsync exclusion sat shipped and
  // undeployed for a month.
  //
  // AFTER `serve()` and never awaited: it must not delay readiness, and a
  // database blip at boot must not stop the worker answering. It only speaks
  // when something is wrong — an absent index is not a degraded mode, it is a
  // silently wrong one.
  // IT REPORTS THE HEALTHY RESULT TOO, and that is not noise.
  //
  // If it only spoke on failure, silence would be the healthy signal — and a
  // container that takes SIGTERM mid-audit (this promise is floating;
  // `shutdown()` does not know about it) would exit 0 having logged nothing,
  // which is BYTE-IDENTICAL to a clean pass. That is the defect this whole
  // branch is about, rebuilt inside the guard against it. One line per boot
  // makes "audited, sound" distinguishable from "never finished".
  void auditDatabaseIndexes()
    .then((audit) => {
      if (audit.refusal !== null) {
        console.error(`[db-index-guard] could not verify: ${audit.refusal}`);
        return;
      }
      if (audit.failing > 0) {
        console.error(`[db-index-guard] ${formatIndexAudit(audit)}`);
        return;
      }
      console.log(`[db-index-guard] ${formatIndexAudit(audit)}`);
    })
    .catch((err) =>
      console.error("[db-index-guard] check failed to run:", err),
    );
});

// Graceful shutdown - stop subscribers, flush logs & metrics, then release port
function shutdown() {
  import("@usemoney/logger").then(({ flushLogs }) =>
    Promise.all([stopPullSubscribers(), flushLogs(), flushMetrics()]).finally(
      () => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(1), 3000);
      },
    ),
  );
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
