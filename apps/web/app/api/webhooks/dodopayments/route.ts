/**
 * DodoPayments payout webhook receiver - scaffold (MONEY-213).
 *
 * v1 ships this endpoint OFF: requests are signature-verified, logged, and
 * return 200 without staging anything. Flipping `FEATURE_DODO_WEBHOOK_INGEST=true`
 * will route `payout.completed` events into the same staging service the
 * manual CSV path uses (MONEY-213 via `@usemoney/services` `gst.stageDodoRows`).
 *
 * Why ship it disabled? The CSV → admin-upload flow is the contract for v1
 * because Dodo doesn't guarantee delivery semantics on these webhooks yet
 * (per their docs as of 2026-04). Having the receiver in place means:
 *   1. We don't 404 if Dodo retries failed deliveries during operator setup.
 *   2. Switching to webhook ingest later is a flag flip, not a code drop.
 */

import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { dbLogger as logger } from "@usemoney/logger";

const WEBHOOK_SECRET = process.env.DODO_WEBHOOK_SECRET;
const FEATURE_INGEST_ENABLED =
  process.env.FEATURE_DODO_WEBHOOK_INGEST === "true";

export async function POST(request: NextRequest) {
  const svixId =
    request.headers.get("webhook-id") || request.headers.get("svix-id");
  const svixTimestamp =
    request.headers.get("webhook-timestamp") ||
    request.headers.get("svix-timestamp");
  const svixSignature =
    request.headers.get("webhook-signature") ||
    request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: "Missing webhook headers" },
      { status: 400 }
    );
  }

  if (!WEBHOOK_SECRET) {
    logger.error("[DODO_PAYOUT_WEBHOOK] DODO_WEBHOOK_SECRET not configured");
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const body = await request.text();
  let payload: { event: string; data: unknown };
  try {
    payload = new Webhook(WEBHOOK_SECRET).verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as typeof payload;
  } catch (err) {
    logger.error({ err }, "[dodo-payout] signature verify failed");
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 }
    );
  }

  logger.info({ event: payload.event }, "[DODO_PAYOUT_WEBHOOK] event received");

  if (!FEATURE_INGEST_ENABLED) {
    // No-op: ack the webhook so Dodo stops retrying, but don't stage.
    return NextResponse.json({ received: true, ingested: false });
  }

  // FEATURE_DODO_WEBHOOK_INGEST=true path is intentionally not wired yet - it
  // will be implemented when we have a documented Dodo payout payload schema
  // to map onto `ParsedDodoRow`. Until then, keep the receiver inert.
  logger.warn(
    { event: payload.event },
    "[DODO_PAYOUT_WEBHOOK] ingest enabled but mapper not implemented - event acknowledged but skipped"
  );
  return NextResponse.json({ received: true, ingested: false });
}
