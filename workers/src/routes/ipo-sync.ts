import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { IpoSyncMessage } from "../processors/ipo-sync";
import { processIpoSync } from "../processors/ipo-sync";

export const ipoSyncRoute = new Hono();

ipoSyncRoute.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    const data = parsePubSubMessage<IpoSyncMessage>(body);
    console.log(`Processing IPO sync (message: ${getMessageId(body)})`);
    const result = await processIpoSync(data);

    if (!result.ok) {
      // MONEY-1238 — the route used to swallow EVERYTHING and answer 200, so
      // the one signal the processor computes for exactly this purpose
      // (`skippedNoStartDate`, the documented signature of an NSE key rename)
      // could never reach anything that decides. 500 = Pub/Sub retries, then
      // dead-letters after 5 attempts, which is where the founder notification
      // lives. The upsert is keyed on (symbol, issueStart), so a redelivery
      // re-writes the same rows.
      //
      // `ok` is now false ONLY for the retriable shape — MONEY-1236. A KEY
      // DRIFT is deterministic and returns `ok: true` with `keyDrift: true` in
      // the body, because retrying an upstream field rename five times a night
      // cannot fix it and dead-letters every run.
      return c.json({ success: false, ...result }, 500);
    }
    if (result.keyDrift) {
      // 200, and LOUD. See the processor: deterministic failures ACK.
      console.error(`[ipo-sync] KEY DRIFT — ${result.reason ?? "no reason"}`);
      return c.json({ success: false, retried: false, ...result }, 200);
    }
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("IPO sync job failed:", error);
    return c.json({ success: false, error: "Processing failed" }, 500);
  }
});
