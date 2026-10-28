import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { FilingsSyncMessage } from "../processors/filings-sync";
import { processFilingsSync } from "../processors/filings-sync";

export const filingsSyncRoute = new Hono();

filingsSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<FilingsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing filings sync (message: ${messageId})`);

    const result = await processFilingsSync(data);

    // MONEY-1238 — 200 so Pub/Sub ACKs and drops the message (a 5xx would burn
    // five delivery attempts and dead-letter a founder notification every
    // Sunday for a defect that is already known), but the BODY does not claim
    // success: the job has no persistence layer, so `wired:false` and a
    // zero-write outcome are the honest answer. See processors/filings-sync.ts.
    return c.json({ success: false, ...result }, 200);
  } catch (error) {
    console.error("Filings sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
