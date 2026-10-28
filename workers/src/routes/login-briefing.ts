/**
 * Login Briefing Worker Route
 *
 * Handles Pub/Sub messages for generating proactive login briefings
 * for Premium users when they sign in.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { LoginBriefingMessage } from "@usemoney/types";
import { processLoginBriefing } from "../processors/login-briefing";

export const loginBriefingRoute = new Hono();

loginBriefingRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<LoginBriefingMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[login-briefing] Processing briefing ${data.briefingId} for user=${data.userId} (message: ${messageId})`,
    );

    await processLoginBriefing(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // MONEY-1238 — 500, not the old unconditional ACK.
    //
    // The processor swallows every failure into `status: "FAILED"`, a value with
    // no reader: both briefing fetches filter `COMPLETED`, and the Clerk
    // `session.created` dedupe matches on the ROW, not its status. ACKing here
    // made that row permanent for 24h, so a single transient Gemini/Mongo blip
    // withheld a paid feature for the day and nothing recorded that it had.
    // 500 = Pub/Sub redelivers the same briefingId; the processor updates one
    // row in place, so a retry is idempotent, and 5 failures dead-letter to the
    // founder notification instead of vanishing.
    console.error("[login-briefing-route] processor threw", { error });
    return c.json({ success: false, error: "Processing failed" }, 500);
  }
});
