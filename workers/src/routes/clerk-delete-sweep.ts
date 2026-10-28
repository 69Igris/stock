/**
 * Clerk Delete Sweep Worker Route (MONEY-144)
 *
 * Hourly Cloud Scheduler trigger. Picks DeletedUserAudit rows where
 * status=LOCKED and clerkDeleteScheduledFor <= now, deletes the
 * Clerk user, flips status=COMPLETED. See processor for details.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ClerkDeleteSweepMessage } from "@usemoney/types/pubsub";
import { processClerkDeleteSweepJob } from "../processors/clerk-delete-sweep";

export const clerkDeleteSweepRoute = new Hono();

clerkDeleteSweepRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ClerkDeleteSweepMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[clerk-delete-sweep] Tick batchSize=${data.batchSize ?? "default"} (message: ${messageId})`,
    );

    const result = await processClerkDeleteSweepJob(data);
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("[clerk-delete-sweep] Job failed:", error);
    return c.json({ success: false }, 500);
  }
});
