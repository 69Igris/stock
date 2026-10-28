import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import { processCircularsSync } from "../processors/circulars-sync";

export const circularsSyncRoute = new Hono();

circularsSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing circulars sync (message: ${getMessageId(body)})`);

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

    const result = await processCircularsSync(
      windowDays === undefined ? undefined : { windowDays },
    );

    if (!result.ok) {
      // 500 so Pub/Sub retries. Safe: identity is (circularNumber, department),
      // so a redelivery re-upserts the same rows.
      return c.json({ success: false, ...result }, 500);
    }
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("Circulars sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
