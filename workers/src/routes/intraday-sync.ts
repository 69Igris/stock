/**
 * Intraday Sync Pub/Sub Push Route - MONEY-123 Part A
 *
 * Receives Cloud Pub/Sub push messages for the `intraday-sync` topic
 * and delegates to the processor. Modeled on routes/price-sync.ts.
 *
 * Schedule: 16:05 IST Mon-Fri (5 min after NSE close) via Cloud
 * Scheduler → `intraday-sync-daily-{env}` job → pushes to
 * `intraday-sync-{env}` topic.
 *
 * HTTP semantics (per the Pub/Sub push contract):
 *   - 200 → Pub/Sub acks the message
 *   - 500 → Pub/Sub retries with exponential backoff
 *
 * Exceptions from processIntradaySync escalate to 500 so transient
 * issues (Yahoo rate-limit, MongoDB blip) get retried automatically.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { IntradaySyncMessage } from "@usemoney/types";
import { processIntradaySync } from "../processors/intraday-sync";

export const intradaySyncRoute = new Hono();

intradaySyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<IntradaySyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[intraday-sync] Received message ${messageId}: ${JSON.stringify(data)}`,
    );

    const result = await processIntradaySync(data);

    if (!result.ok) {
      // 200, NOT 500 — same reasoning as routes/price-sync.ts. The house idiom
      // (routes/xbrl-sync.ts) says transient -> 500 so Pub/Sub retries, and a
      // Yahoo outage IS transient — but this run is 500 symbols × 3 intervals
      // with a 200 ms pause every 10 symbols, so a NACK asks for a second
      // concurrent copy of a job that already strains the 600 s ack deadline.
      // The decider being wired is the `marketDataSyncLog` row, whose `status`
      // is now computed from the run's counts instead of a literal
      // "COMPLETED" (MONEY-1238).
      console.error(`[intraday-sync] run reported FAILED: ${result.reason}`);
      return c.json({ success: false, retried: false, ...result }, 200);
    }

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("[intraday-sync] Job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
