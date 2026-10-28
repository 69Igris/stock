/**
 * Pull Subscription Manager
 *
 * For local development: pulls messages from GCP Pub/Sub topics
 * using streaming pull, then routes to the matching processor.
 *
 * In production, Pub/Sub push subscriptions deliver to Cloud Run HTTP
 * endpoints. Locally, push can't reach localhost, so we pull instead.
 */

import type { Message, Subscription } from "@google-cloud/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types";

import { processPairing } from "../processors/pairing";
import { processImport } from "../processors/import";
import { processSync } from "../processors/sync";
import { processInstrumentSync } from "../processors/instrument-sync";
import { processPriceSync } from "../processors/price-sync";
import { processSectorEnrichment } from "../processors/sector-enrichment";
import { processResearch } from "../processors/research";
import { processMfSync } from "../processors/mf-sync";
import { processMfMetadataSync } from "../processors/mf-metadata-sync";
import { processDocument } from "../processors/document-process";
import { processRoast } from "../processors/roast";
import { processXbrlProjection } from "../processors/xbrl-projection";
import { processXbrlRatios } from "../processors/xbrl-ratios";
import { processNewsSync } from "../processors/news-sync";
import { processFilingsSync } from "../processors/filings-sync";
import { processChartinkStrategySync } from "../processors/chartink-strategy-sync";
import { processStrategyScan } from "../processors/strategy-scan";
// StockSage 2.0 (MONEY-779) — the new worker jobs, so local dev picks them up.
import { processStockDocumentSync } from "../processors/stock-document-sync";
import { processStockDocumentExtract } from "../processors/stock-document-extract";
import { processStockDocumentEmbed } from "../processors/stock-document-embed";
import { processInvestorRollup } from "../processors/investor-rollup";
// MONEY-980 — the nightly Tiingo US price backbone.
import { processUsEodSync } from "../processors/us-eod-sync";
import { processTiingoNewsPoll } from "../processors/tiingo-news-poll";

/**
 * Processor signature: receives the parsed message data, runs the job.
 *
 * The payload arrives off the wire via `parseMessageData` (JSON-parsed from an
 * untrusted Buffer), so it is structurally `unknown`; each concrete processor
 * declares its own narrower `*JobMessage` parameter. The parameter is typed
 * `any` (not `unknown`) ON PURPOSE: under `strictFunctionTypes` a function that
 * takes a specific `*JobMessage` is NOT assignable to `(data: unknown) => …`
 * (contravariant params), so an `unknown` parameter would reject every entry in
 * the map below. `any` keeps the bivariant assignment that lets each typed
 * processor slot in unchanged. The topic↔shape safety the map needs is enforced
 * instead by the {@link PubSubTopic}-keyed `Record` (a wrong topic fails the
 * build); the payload itself is validated inside each processor.
 *
 * The result is `Promise<unknown>`, not `Promise<void>`: some processors return
 * a value (e.g. `processInvestorRollup` → a counts object) and the
 * `PubSubTopic`-keyed `Record` below runs an EXACT computed-property check that
 * rejects a non-`void` return under `Promise<void>`. `handlePullMessage` awaits
 * and discards the result, so this is type-only — runtime is unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PullProcessor = (data: any) => Promise<unknown>;

/**
 * The set of valid Pub/Sub topic base names (the VALUES of `PUBSUB_TOPICS`).
 * Keying {@link TOPIC_PROCESSORS} to this — rather than a bare `string` — turns a
 * mistyped or non-existent topic name into a COMPILE error instead of a
 * silently-dead local subscription. MONEY-807.
 */
type PubSubTopic = (typeof PUBSUB_TOPICS)[keyof typeof PUBSUB_TOPICS];

// Topic base name → processor function. `Partial<Record<PubSubTopic, …>>`
// because only the topics a local worker pulls are mapped (the rest are
// push-only / web-only); every KEY must still be a real `PUBSUB_TOPICS` value,
// so a wrong/renamed topic fails the build (the exhaustiveness guard).
export const TOPIC_PROCESSORS: Partial<Record<PubSubTopic, PullProcessor>> = {
  [PUBSUB_TOPICS.TRADE_PAIRING]: processPairing,
  [PUBSUB_TOPICS.CSV_IMPORT]: processImport,
  [PUBSUB_TOPICS.BROKER_SYNC]: processSync,
  [PUBSUB_TOPICS.INSTRUMENT_SYNC]: processInstrumentSync,
  [PUBSUB_TOPICS.PRICE_SYNC]: processPriceSync,
  [PUBSUB_TOPICS.SECTOR_ENRICHMENT]: processSectorEnrichment,
  [PUBSUB_TOPICS.STOCK_RESEARCH]: processResearch,
  [PUBSUB_TOPICS.MF_SYNC]: processMfSync,
  [PUBSUB_TOPICS.MF_METADATA_SYNC]: processMfMetadataSync,
  [PUBSUB_TOPICS.DOCUMENT_PROCESS]: processDocument,
  [PUBSUB_TOPICS.PORTFOLIO_ROAST]: processRoast,
  // financial-data-sync is RETIRED (MONEY-1220) — its topic constant is gone. Its work
  // moved to the two below, which are registered here so local dev picks them
  // up the same way prod does.
  [PUBSUB_TOPICS.XBRL_PROJECTION]: processXbrlProjection,
  [PUBSUB_TOPICS.XBRL_RATIOS]: processXbrlRatios,
  [PUBSUB_TOPICS.NEWS_SYNC]: processNewsSync,
  [PUBSUB_TOPICS.FILINGS_SYNC]: processFilingsSync,
  [PUBSUB_TOPICS.CHARTINK_STRATEGY_SYNC]: processChartinkStrategySync,
  [PUBSUB_TOPICS.STRATEGY_SCAN]: processStrategyScan,
  // StockSage 2.0 (MONEY-779). NOTE: these also have QA Cloud Run push subs +
  // daily schedulers; when local pull is active it is a SEPARATE subscription,
  // so a published message reaches both (competing-consumer) — same as every
  // other entry here. The jobs are idempotent, so local dev double-processing
  // is safe. Don't run local workers + rely on QA for the same user at once.
  [PUBSUB_TOPICS.STOCK_DOCUMENT_SYNC]: processStockDocumentSync,
  [PUBSUB_TOPICS.STOCK_DOCUMENT_EXTRACT]: processStockDocumentExtract,
  [PUBSUB_TOPICS.STOCK_DOCUMENT_EMBED]: processStockDocumentEmbed,
  [PUBSUB_TOPICS.INVESTOR_ROLLUP]: processInvestorRollup,
  // MONEY-980 — the US price backbone. Registered here so a local worker picks
  // it up the same way prod does. NOTE it needs TIINGO_API_KEY in the local
  // env; without it the client throws on the first call and the run reports a
  // transport failure rather than pretending to be an idle night.
  [PUBSUB_TOPICS.US_EOD_SYNC]: processUsEodSync,
  // MONEY-1309 — the 24x7 news poller that SUPERSEDES us-eod-sync leg (f).
  // Needs TIINGO_API_KEY locally, same as the row above. A local run is
  // harmless and idempotent: the upsert keys on Tiingo's own article id, and
  // the cursor advances only to rows that were actually written.
  [PUBSUB_TOPICS.TIINGO_NEWS_POLL]: processTiingoNewsPoll,
};

export const ACK_DEADLINE_SECONDS = 600; // 10 min - matches push subscription
export const EXPIRATION_MS = 31 * 24 * 60 * 60 * 1000; // 31 days idle auto-cleanup
export const MESSAGE_RETENTION_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const MAX_DELIVERY_ATTEMPTS = 5; // Ack after this many failures to prevent infinite retry

const activeSubscriptions: Subscription[] = [];

// Track delivery attempts per message ID to prevent infinite retry loops.
// Entries are cleaned up after ack or when they exceed MAX_DELIVERY_ATTEMPTS.
const deliveryAttempts = new Map<string, number>();

/** Local-dev pull subscription name for a given (env-suffixed) topic. */
export function getSubscriptionName(topicName: string): string {
  return `${topicName}-pull-local`;
}

/** Parse a Pub/Sub pull message payload (base64-decoded Buffer) as JSON. */
export function parseMessageData(data: Buffer): unknown {
  return JSON.parse(data.toString("utf-8"));
}

/**
 * Classify a subscription-setup error: a missing topic ("NOT_FOUND") is an
 * expected skip in local dev; anything else is an unexpected failure.
 */
export function classifyError(err: unknown): "not-found" | "other" {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("NOT_FOUND")) {
    return "not-found";
  }
  return "other";
}

/**
 * MONEY-708 — bound how many messages this subscriber pulls at once.
 *
 * SCOPE, corrected. The first version of this comment claimed the unbounded
 * pull was a PRODUCTION risk — "every message an in-flight processor competing
 * for one Cloud Run instance's heap and Mongo pool" — and that the setting
 * would govern "every existing subscription… in QA and prod". Both are wrong,
 * and `index.ts` says so directly a few lines from where it calls this:
 *
 *   "Pull subscriber is for LOCAL development only (push can't reach
 *    localhost). On Cloud Run (production/qa), Pub/Sub push subscriptions
 *    deliver directly."
 *
 * `shouldEnablePullSubscriber` (index-logic.ts) only returns true for
 * `ENABLE_PULL_SUBSCRIBER=true`, `NODE_ENV=development` or `PUBSUB_ENV=local`
 * — fail-closed local-only by design (MONEY-807, so a deployed worker never
 * steals its own push traffic). The `${topic}-pull-local` subscriptions this
 * names are created by `setup-pubsub.sh` ONLY in its `local` branch; QA and
 * prod get `--push-endpoint` subscriptions, which client-side `flowControl`
 * cannot govern at all.
 *
 * So what this actually protects is a LOCAL machine: replaying a backlog into
 * a laptop that is also running the web app, Mongo and Redis. That is a real
 * (if smaller) benefit and worth keeping — it just is not the production story
 * the original comment told.
 *
 * PRODUCTION concurrency is a DEPLOY setting, not a code one:
 * `workers/cloudbuild.yaml` sets `--concurrency 10` and `--max-instances 10`
 * against `--memory 1Gi --cpu 1`. So the real question — is 10 concurrent
 * bhavcopy parses / document extractions / research runs right for 1Gi? — is
 * answered there, and changing it trades throughput for headroom. Flagged
 * rather than silently retuned.
 *
 * `allowExcessMessages: false` is the half that does the work: left at the
 * client default `true`, the client accepts MORE than `maxMessages` and only
 * defers their delivery callbacks, which is not a limit.
 */
export const MAX_CONCURRENT_MESSAGES = 5;

/** Flow control applied to every subscription this worker listens on. */
export const SUBSCRIBER_FLOW_CONTROL = {
  maxMessages: MAX_CONCURRENT_MESSAGES,
  allowExcessMessages: false,
} as const;

/** Options used when auto-creating a local-dev pull subscription. */
export function buildSubscriptionOptions(): {
  ackDeadlineSeconds: number;
  expirationPolicy: { ttl: { seconds: number } };
  messageRetentionDuration: { seconds: number };
} {
  return {
    ackDeadlineSeconds: ACK_DEADLINE_SECONDS,
    expirationPolicy: { ttl: { seconds: EXPIRATION_MS / 1000 } },
    messageRetentionDuration: { seconds: MESSAGE_RETENTION_SECONDS },
  };
}

/** Minimal shape of a Pub/Sub message that the pull handler relies on. */
export interface PullMessageLike {
  id: string;
  data: Buffer;
  ack: () => void;
  nack: () => void;
}

/**
 * Handle a single pulled message: track delivery attempts, dead-letter (ack)
 * after MAX_DELIVERY_ATTEMPTS, otherwise parse → process → ack, or nack on
 * failure. `attempts` defaults to the shared module-level map but can be
 * supplied for isolated testing.
 */
export async function handlePullMessage(
  message: PullMessageLike,
  processor: PullProcessor,
  baseTopic: string,
  attempts: Map<string, number> = deliveryAttempts,
): Promise<void> {
  const messageId = message.id;
  const count = (attempts.get(messageId) ?? 0) + 1;
  attempts.set(messageId, count);

  // Prevent infinite retry loops: ack and discard after MAX_DELIVERY_ATTEMPTS
  if (count > MAX_DELIVERY_ATTEMPTS) {
    console.error(
      `  [pull-subscriber] DEAD-LETTER ${baseTopic} message ${messageId} after ${count} attempts - acking to stop retries`,
    );
    attempts.delete(messageId);
    message.ack();
    return;
  }

  console.log(
    `  [pull-subscriber] Processing ${baseTopic} message ${messageId} (attempt ${count})`,
  );

  try {
    const data = parseMessageData(message.data);
    await processor(data);
    attempts.delete(messageId);
    message.ack();
    console.log(
      `  [pull-subscriber] Completed ${baseTopic} message ${messageId}`,
    );
  } catch (err) {
    console.error(
      `  [pull-subscriber] Failed ${baseTopic} message ${messageId} (attempt ${count}/${MAX_DELIVERY_ATTEMPTS}):`,
      err,
    );
    message.nack();
  }
}

/**
 * Choose which topics a local pull worker subscribes to.
 *
 * When `PULL_TOPICS` is set (comma-separated BASE topic names, e.g.
 * "stock-research" or "stock-research,portfolio-roast") ONLY those topics are
 * pulled — so a research-only local session doesn't drown in the scheduler-
 * driven broker-sync / price-sync firehose (each of which can back up thousands
 * of messages on the busy QA topics). Unset/blank → every mapped topic (the
 * unchanged default). Unknown names are dropped silently here; the caller logs
 * the resolved selection so a typo is visible. Pure + exported for unit tests.
 */
export function selectPullTopics(
  processors: Partial<Record<PubSubTopic, PullProcessor>>,
  pullTopicsEnv: string | undefined,
): [string, PullProcessor][] {
  const all = Object.entries(processors).filter(
    (e): e is [string, PullProcessor] => Boolean(e[1]),
  );
  const raw = (pullTopicsEnv ?? "").trim();
  if (!raw) return all;
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return all.filter(([baseTopic]) => wanted.has(baseTopic));
}

/**
 * Start streaming pull listeners.
 * Auto-creates pull subscriptions if they don't exist.
 *
 * Subscribes to every mapped topic by default, or ONLY the topics named in
 * `PULL_TOPICS` when set (see selectPullTopics) — e.g.
 * `PULL_TOPICS=stock-research yarn workspace @usemoney/workers dev` runs a
 * research-only local worker.
 *
 * Uses the Subscriber API directly to avoid needing pubsub.topics.get
 * permission (Publisher Admin). Only requires Subscriber role permissions.
 */
export async function startPullSubscribers(): Promise<void> {
  const client = getPubSubClient();

  console.log("\n  Starting Pub/Sub Pull Subscribers...\n");

  const selected = selectPullTopics(TOPIC_PROCESSORS, process.env.PULL_TOPICS);
  if ((process.env.PULL_TOPICS ?? "").trim()) {
    console.log(
      `  PULL_TOPICS set → pulling ONLY: ${
        selected.map(([t]) => t).join(", ") ||
        "(no topic matched — check names)"
      }\n`,
    );
  }

  for (const [baseTopic, processor] of selected) {
    const topicName = getTopicName(baseTopic);
    const subscriptionName = getSubscriptionName(topicName);

    try {
      // Use client.subscription() directly - avoids topic.exists() which
      // requires pubsub.topics.get (Publisher Admin permission).
      // MONEY-708 — flow control is applied at SUBSCRIBE time, not at create
      // time, so it governs every existing subscription too (the ones created
      // by scripts/setup-pubsub.sh in QA/prod, which is all of them).
      const subscription = client.subscription(subscriptionName, {
        flowControl: SUBSCRIBER_FLOW_CONTROL,
      });
      const [subExists] = await subscription.exists();

      if (!subExists) {
        // createSubscription(topic, subscriptionName, options)
        await client.createSubscription(
          topicName,
          subscriptionName,
          buildSubscriptionOptions(),
        );
        console.log(`    [new] Created subscription ${subscriptionName}`);
      }

      // Start listening
      subscription.on("message", (message: Message) => {
        void handlePullMessage(message, processor, baseTopic);
      });

      subscription.on("error", (err) => {
        console.error(
          `  [pull-subscriber] Subscription error on ${subscriptionName}:`,
          err,
        );
      });

      activeSubscriptions.push(subscription);
      console.log(`    ✓ ${topicName} → listening`);
    } catch (err) {
      if (classifyError(err) === "not-found") {
        console.log(`    [skip] ${topicName} → topic does not exist`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`    ✗ ${topicName} → failed: ${msg}`);
      }
    }
  }

  console.log(
    `\n  Pull Subscribers: ${activeSubscriptions.length}/${selected.length} active\n`,
  );
}

/**
 * Gracefully close all pull subscriptions.
 */
export async function stopPullSubscribers(): Promise<void> {
  await Promise.all(activeSubscriptions.map((sub) => sub.close()));
  activeSubscriptions.length = 0;
  console.log("  All pull subscribers stopped.");
}
