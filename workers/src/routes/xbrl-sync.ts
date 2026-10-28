import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import { processXbrlSync } from "../processors/xbrl-sync";
import { isRetriableFailure } from "../processors/xbrl-sync-logic";

export const xbrlSyncRoute = new Hono();

xbrlSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing XBRL sync (message: ${getMessageId(body)})`);

    // `windowDays` lets an operator widen the trailing window for a catch-up
    // run without a deploy. The P10 F2 backfill uses explicit from/to instead
    // and goes through the script, not this route.
    // UNWRAP THE ENVELOPE FIRST — MONEY-1490.
    //
    // A Pub/Sub push delivers `{message: {data: "<base64>", messageId}}`,
    // not the payload, so reading `windowDays` off `body` yielded `undefined`
    // on every scheduled run and the override above was reachable only from a
    // direct curl. Harmless today — the scheduler publishes `{}` — but the
    // comment promises an operator a catch-up lever that did not work.
    // `parsePubSubMessage` falls back to the body when it is not an envelope,
    // so manual invocation is unchanged.
    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ?? {}) as {
      windowDays?: unknown;
    };
    const windowDays =
      typeof raw.windowDays === "number" && Number.isFinite(raw.windowDays)
        ? Math.max(1, Math.min(370, Math.floor(raw.windowDays)))
        : undefined;

    const result = await processXbrlSync(
      windowDays === undefined ? undefined : { windowDays },
    );

    if (!result.ok) {
      // The response code is chosen by FAILURE CLASS, not by `ok` — MONEY-1200.
      //
      // TRANSIENT (the index was unreadable): 500 so Pub/Sub retries. Safe and
      // cheap: identity is the period tuple so a redelivery re-upserts the same
      // rows, and the run fails before downloading anything.
      //
      // DETERMINISTIC (parse health): 200. The same bytes will fail the same
      // way on every attempt, and each attempt re-downloads up to 1,500 XMLs
      // from NSE — a taxonomy gap would turn into a retry storm against the
      // exchange. The trailing window, not the retry, is what heals it once the
      // concept table is taught. See `isRetriableFailure` for the full
      // reasoning and for the ack-deadline problem it does NOT fix.
      if (isRetriableFailure(result)) {
        return c.json({ success: false, ...result }, 500);
      }
      console.error(
        "XBRL sync FAILED deterministically — acking to avoid a retry storm:",
        result.parseHealthFailure,
      );
      return c.json({ success: false, retried: false, ...result }, 200);
    }
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("XBRL sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
