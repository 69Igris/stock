/**
 * POST /jobs/mf-nav-backfill — MONEY-1205.
 *
 * Returns 500 on a throw so Pub/Sub retries: the failure modes this job reports
 * (MFAPI.in unreachable / rate-limiting) are exactly the transient kind a retry
 * fixes, and a re-run is cheap because the processor only inserts dates it does
 * not already have.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { MfNavBackfillMessage } from "@usemoney/types";
import { processMfNavBackfill } from "../processors/mf-nav-backfill";

export const mfNavBackfillRoute = new Hono();

mfNavBackfillRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<MfNavBackfillMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing MF NAV backfill job (message: ${messageId})`);

    await processMfNavBackfill(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("MF NAV backfill job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
