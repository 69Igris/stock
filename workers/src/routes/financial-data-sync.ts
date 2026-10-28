import { Hono } from "hono";
import { getMessageId } from "../lib/message";

/**
 * RETIRED — MONEY-1220. Kept, and answers 200, deliberately.
 *
 * (This line said "kept as a 410" while the handler returned 200 and the rest of
 * this docblock argued for 200. The code was right; the summary was a leftover
 * from the first draft.)
 *
 * `financial-data-sync` had exactly one data source, Tickertape, and Tickertape
 * now returns 403 to our Cloud Run egress (200 from a laptop — an egress block,
 * not an outage). Both of its legs have replacements that read our own archived
 * NSE filings instead:
 *
 *   statements + quarterly  ->  /jobs/xbrl-projection
 *   ratios                  ->  /jobs/xbrl-ratios
 *
 * ## Why the route SURVIVES, and why it answers 200
 *
 * The two schedulers are removed from `setup-scheduler.sh` AND added to its
 * stale-delete list, so `setup-scheduler.sh prod` takes them down. But a
 * scheduler is live infrastructure, not a file: until someone actually runs
 * that script the jobs keep firing, and any message already on the topic keeps
 * being delivered. Deleting the route would make those deliveries 404 — a
 * non-2xx, so Pub/Sub NACKs and redelivers with backoff until
 * `--max-delivery-attempts=5` parks the message on the dead-letter topic. Five
 * retries and a DLQ notification, every week, for a job we retired on purpose.
 *
 * So the route stays and ACKs.
 *
 * **200, not 410**, and the distinction is not cosmetic: Pub/Sub acknowledges
 * only on 102/200/201/202/204. Every other status — 410 emphatically included —
 * is a NACK, so the semantically-correct "Gone" would produce exactly the retry
 * storm this route exists to prevent. The body carries `retired: true` and the
 * reason, which is what a human curling it needs; the status code is for the
 * transport, and the transport only understands "consumed" or "try again".
 *
 * It also leaves a searchable answer for the next person who greps for this job
 * after finding its scheduler in their console history.
 */
export const financialDataSyncRoute = new Hono();

const RETIRED_MESSAGE =
  "financial-data-sync is retired (MONEY-1220). Tickertape 403s our egress; " +
  "statements are now written by /jobs/xbrl-projection and ratios by " +
  "/jobs/xbrl-ratios, both derived from our own archived NSE XBRL filings.";

financialDataSyncRoute.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  console.warn(
    `[financial-data-sync] RETIRED — dropping message ${getMessageId(body)}. ${RETIRED_MESSAGE}`,
  );
  // 200 = ACK. Consume and discard, rather than burning five delivery attempts
  // and a dead-letter notification on a job that was retired deliberately.
  return c.json({ success: true, retired: true, reason: RETIRED_MESSAGE });
});
