import { Hono } from "hono";
import { processDeadLetter } from "../processors/dead-letter-consumer";

/**
 * `POST /jobs/dead-letter` — the consumer for `dead-letter-${ENV}` (MONEY-1204).
 *
 * Unlike every other job route this one has NO 500 path. A 5xx nacks, and a
 * nacked dead letter goes back onto the dead-letter queue, which has no further
 * backstop; the message would then redeliver against the same broken condition
 * until the 7-day retention expires. So the handler always returns 200 and the
 * failure detail goes to the log instead.
 *
 * It also does not call `parsePubSubMessage`: the processor needs the whole
 * envelope (attributes carry Pub/Sub's `CloudPubSubDeadLetterSource*` fields,
 * which is the only place the ORIGINAL subscription and delivery count exist),
 * not just the decoded `data`.
 */
export const deadLetterRoute = new Hono();

deadLetterRoute.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const outcome = await processDeadLetter(body);
    return c.json({ success: true, ...outcome }, 200);
  } catch (error) {
    // `processDeadLetter` is written not to throw. If it somehow does, ACK
    // regardless — see the note above.
    console.error("[dead-letter] handler threw; acking anyway", error);
    return c.json({ success: true, acked: true, error: "handler_threw" }, 200);
  }
});
