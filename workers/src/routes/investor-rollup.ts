/**
 * Investor Rollup Worker Route (MONEY-789, B4)
 *
 * Handles the nightly Cloud Scheduler → Pub/Sub trigger that runs the investor
 * self-learning rollup: derive behaviour snapshots, drift profiles, decay
 * stale mastery, rebuild insights, reproject FIRE. See the processor for
 * details.
 *
 * ACKs 200 even on a throw — a nightly sweep must never trigger a Pub/Sub
 * retry storm.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { InvestorRollupMessage } from "@usemoney/types/pubsub";
import { processInvestorRollup } from "../processors/investor-rollup";

export const investorRollupRoute = new Hono();

investorRollupRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<InvestorRollupMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[investor-rollup] Tick activeWindowDays=${data.activeWindowDays ?? "default"} decayAfterDays=${data.decayAfterDays ?? "default"} (message: ${messageId})`,
    );

    const result = await processInvestorRollup(data);
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("[investor-rollup-route] processor threw, acking", { error });
    return c.json({ success: true }, 200); // ACK to prevent retries
  }
});
