/**
 * Pub/Sub job publishers (@usemoney/pubsub).
 *
 * Ported 1:1 from apps/web/lib/pubsub/publish.ts — the web app was the only
 * publisher (workers consume). Each helper resolves the env-suffixed topic via
 * `getTopicName(PUBSUB_TOPICS.*)` and publishes the JSON payload, returning the
 * Pub/Sub message id.
 */

import { getPubSubClient } from "./client";
import {
  PUBSUB_TOPICS,
  getTopicName,
  type PairingJobMessage,
  type ImportJobMessage,
  type SyncJobMessage,
  type ResearchJobMessage,
  type DocumentProcessMessage,
  type RoastJobMessage,
  type ComparisonJobMessage,
  type L3AnalysisMessage,
  type LoginBriefingMessage,
  type StrategyScanMessage,
  type ResearchPreviewPlanJobMessage,
  type AccountDeletionMessage,
  type ClerkDeleteSweepMessage,
} from "@usemoney/types";

export async function publishPairingJob(
  data: PairingJobMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.TRADE_PAIRING));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishImportJob(
  data: ImportJobMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.CSV_IMPORT));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishSyncJob(data: SyncJobMessage): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.BROKER_SYNC));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishResearchJob(
  data: ResearchJobMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.STOCK_RESEARCH));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishResearchPreviewPlanJob(
  data: ResearchPreviewPlanJobMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.RESEARCH_PREVIEW_PLAN));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishDocumentProcessJob(
  data: DocumentProcessMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.DOCUMENT_PROCESS));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishRoastJob(data: RoastJobMessage): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.PORTFOLIO_ROAST));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishComparisonJob(
  data: ComparisonJobMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.COMPARISON_ANALYSIS));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishLoginBriefingJob(
  data: LoginBriefingMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.LOGIN_BRIEFING));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishL3AnalysisJob(
  data: L3AnalysisMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.L3_ANALYSIS));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishStrategyScanJob(
  data: StrategyScanMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.STRATEGY_SCAN));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

export async function publishAccountDeletionJob(
  data: AccountDeletionMessage,
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.ACCOUNT_DELETION));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}

/**
 * MONEY-144 — publish a Clerk-delete sweep tick. Typically invoked
 * by Cloud Scheduler on an hourly cron; payload is bounded so a single
 * run finishes inside the Cloud Run request window.
 */
export async function publishClerkDeleteSweepJob(
  data: ClerkDeleteSweepMessage = {},
): Promise<string> {
  const client = getPubSubClient();
  const topic = client.topic(getTopicName(PUBSUB_TOPICS.CLERK_DELETE_SWEEP));
  const messageId = await topic.publishMessage({ json: data });
  return messageId;
}
