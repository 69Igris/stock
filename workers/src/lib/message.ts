/**
 * Pub/Sub Message Parser
 *
 * Parses Google Cloud Pub/Sub push message envelopes
 * into typed job data.
 *
 * Also supports direct JSON bodies for local development:
 * - POST with `{"message":{"data":"<base64>"}}` → Pub/Sub envelope
 * - POST with `{"exchanges":["NSE"]}` → Direct JSON (no envelope)
 */

import type { PubSubPushMessage } from "@usemoney/types";

/**
 * Check if the body looks like a Pub/Sub push envelope.
 */
function isPubSubEnvelope(body: unknown): body is PubSubPushMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof (body as PubSubPushMessage).message?.data === "string"
  );
}

/**
 * Parse and decode a Pub/Sub push message body into typed data.
 * Falls back to treating the body as direct JSON if it's not a Pub/Sub envelope.
 */
export function parsePubSubMessage<T>(body: unknown): T {
  if (isPubSubEnvelope(body)) {
    const decoded = Buffer.from(body.message.data, "base64").toString("utf-8");
    return JSON.parse(decoded) as T;
  }

  // Direct JSON body (local dev / manual trigger)
  return body as T;
}

/**
 * The envelope's `publishTime` as a Date, or null for a direct body.
 *
 * STABLE ACROSS REDELIVERIES of the same message, which is why it is the right
 * clock for anything a NACK will retry. `messageId` is stable too but carries
 * no time; the wall clock is neither.
 */
export function publishTimeOf(body: unknown): Date | null {
  if (!isPubSubEnvelope(body)) return null;
  const raw = (body.message as { publishTime?: unknown }).publishTime;
  if (typeof raw !== "string") return null;
  const d = new Date(raw);
  // An unparseable stamp must not silently become 1970 — fall back to the
  // caller's own clock instead, which is at least monotonic with reality.
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Extract the Pub/Sub messageId from the push envelope.
 * Returns a generated ID for direct JSON bodies.
 */
export function getMessageId(body: unknown): string {
  if (isPubSubEnvelope(body) && body.message.messageId) {
    return body.message.messageId;
  }

  // Generate a local ID for direct invocations
  return `local-${Date.now()}`;
}
