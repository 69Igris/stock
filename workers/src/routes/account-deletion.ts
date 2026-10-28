/**
 * Account Deletion Worker Route (MONEY-391)
 *
 * Handles Pub/Sub messages for the async account-deletion pipeline
 * fired by the web server action after OTP verification + audit row
 * write. See workers/src/processors/account-deletion.ts for the
 * actual cleanup logic.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { AccountDeletionMessage } from "@usemoney/types/pubsub";
import { processAccountDeletionJob } from "../processors/account-deletion";

export const accountDeletionRoute = new Hono();

accountDeletionRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<AccountDeletionMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[account-deletion] Processing userId=${data.userId} clerkId=${data.clerkId} (message: ${messageId})`,
    );

    await processAccountDeletionJob(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("[account-deletion] Job failed:", error);
    // Return 500 so Pub/Sub retries (processAccountDeletion already
    // flipped the audit row to FAILED so admin sees it)
    return c.json({ success: false }, 500);
  }
});
