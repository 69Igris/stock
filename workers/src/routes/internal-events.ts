/**
 * `POST /jobs/us-filing-events` — MONEY-1507 (C1), remounted by MONEY-1520.
 *
 * The one door `services/us-fundamentals` (Python) uses to produce events.
 *
 * ## IT WAS `POST /internal/events`, AND IT 404'd EVERY CALL
 *
 * The producer POSTed here directly with an OIDC token. It never once reached
 * this file: `stockbook-workers-{env}` carries `run.googleapis.com/ingress:
 * internal` and `us-fundamentals-{env}` has no VPC egress, so the request left
 * over the public internet and Cloud Run refused it AT THE EDGE. The proof it
 * never reached the app is the status code — `/internal/*` was gated by
 * `jobsAuth`, which answers 401 on a missing or invalid token and has no 404
 * path at all. An internal-ingress service answers an external caller 404
 * precisely so it does not reveal that it exists. `instrument_events` held
 * 4,019 rows, not one of them `SEC_EDGAR`, while the detector claimed filings
 * every minute and reported `failed: 0`.
 *
 * So the producer PUBLISHES now, and this route is a push consumer. Pub/Sub
 * push is not external traffic — the whole reason the ~55 sibling job routes
 * reach this same service without trouble.
 *
 * THE FILE AND SYMBOL NAMES ARE UNCHANGED ON PURPOSE. Nothing about the
 * REQUEST moved: the message body IS the body this route already accepted, the
 * zod contract is untouched, and `parsePubSubMessage` already decoded a push
 * envelope (it falls back to the bare body). Renaming three modules and their
 * tests to match a path would be churn with no behaviour in it.
 *
 * ## THE PATH SEGMENT IS THE TOPIC NAME
 *
 * `setup-pubsub.sh` builds every worker push endpoint as
 * `${SERVICE_URL}/jobs/${BASE_TOPIC}`, and `route-registration-coverage.test.ts`
 * joins `BASE_WORKER_TOPICS` against the `/jobs/*` mounts in both directions. A
 * bespoke endpoint would be a second convention that no guard checks — and the
 * failure mode of getting it wrong is a 404 on every delivery, which is the
 * shape this ticket exists to remove, one layer in.
 *
 * ## IT IS OIDC-GATED, BY THE SAME FACTORY AS EVERY OTHER JOB ROUTE
 *
 * `/jobs/*` carries `createJobsAuthMiddleware` in `index.ts`, so the gate did
 * not move with the route. MONEY-288 was a fail-open gate on a route family
 * that could trigger every processor with an arbitrary payload; this one WRITES
 * to a serving collection the alert evaluator reads, so an unauthenticated
 * caller could notify every user holding a stock.
 *
 * `/jobs/*` also carries `pubsubDedupeMiddleware`, which `/internal/*` did not.
 * That is a bonus and not the argument: `publishEvents` upserts on a
 * deterministic `eventId`, so a duplicate delivery is free.
 *
 * CORRECTED (MONEY-1514 review): this used to say the dedupe stops a redelivery
 * re-stamping `observedAt`. It does not — dedupe skips a duplicate of an ACKED
 * message, while a 500-NACK retry is granted RUN by `reclaim_after_failure`.
 * The re-stamp is prevented in the handler instead: `observedAt` comes from the
 * MESSAGE — each filing's own `observedAt` (MONEY-1532), else the envelope's
 * `publishTime` — and both are identical on every delivery of one message.
 *
 * ## STATUS CODES — PUB/SUB ACKS ONLY ON 2xx, SO A 2xx MEANS "DONE"
 *
 * 400 on an invalid request. Deterministic, so every redelivery collects the
 * identical rejection and the message parks on `dead-letter-{env}` after five
 * attempts — WITH ITS PAYLOAD, which is the point. The alternative this repo
 * uses elsewhere (200-and-drop, as the retired `financial-data-sync` route
 * does) is right for a standing stream on an inert topic and wrong here: a
 * producer bug is exceptional, and dropping the batch would return the lane to
 * the silent-loss shape the ticket is about.
 *
 * 500 on an infrastructure failure, and ALSO on `failed > 0`. That second one
 * is the change: the route used to answer 200 with `success: false` for a
 * partially-written batch. Under a direct POST that was merely a number the
 * caller logged; under Pub/Sub a 200 ACKS, and the events whose upsert threw
 * would be gone with nothing to redeliver them. A retry re-upserts the rows
 * that already landed, which is free — they are keyed on `eventId`.
 *
 * 200 only when every event in the batch is in Mongo.
 *
 * THE DLQ IS THE RETRY CHANNEL HERE, unlike `/jobs/us-filing-insight`, which
 * ACKs 200 on every path because its leaves spend PAID model calls and its
 * retry channel is an `insightStatus` column. This lane's unit of work is a
 * cheap idempotent upsert, so redelivery costs nothing and parking preserves
 * the payload.
 */

import { Hono } from "hono";
import { ZodError } from "zod";
import {
  getMessageId,
  parsePubSubMessage,
  publishTimeOf,
} from "../lib/message";
import { ackStatusFor } from "../processors/internal-events-logic";
import { processInternalEvents } from "../processors/internal-events";

export const internalEventsRoute = new Hono();

internalEventsRoute.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const payload = parsePubSubMessage<unknown>(body);
    // `observedAt` COMES FROM THE ENVELOPE, NOT FROM `now()` — MONEY-1514 review.
    //
    // `ackStatusFor` nacks a partially-written batch so Pub/Sub redelivers it.
    // The upsert is keyed on `eventId` and every other field is derived from
    // the filing, so a redelivery is free — EXCEPT `observedAt`, which is the
    // one non-idempotent field in this route. `defaultUpsert`'s `update:` block
    // `$set`s it unconditionally, so a retry would re-stamp rows that already
    // landed, and `eventSilverKey` includes `observed_at` — so the lake sink
    // would append a SECOND `instrument_event` row, indistinguishable from a
    // legitimate enrichment.
    //
    // `publishTime` is stable across every redelivery of the same message,
    // which is exactly the property needed. A direct body (local dev, manual
    // trigger) has no envelope and falls back to the wall clock.
    //
    // MONEY-1532 — and it is now the FALLBACK, not the answer. Each filing
    // carries its own `observedAt` (`us_filings.detectedAt`, the claim
    // instant), which the processor prefers when it is usable
    // (`payloadObservedAt`). `publishTime` is up to a 420 s detect run late
    // for a live filing, and for one re-emitted by `{"mode":"event-backfill"}`
    // it is TODAY: a week-old filing would arrive as new and fire every alert
    // on it at once. The payload value is in the message body, so it is as
    // stable across a redelivery as `publishTime` is.
    //
    // NOTE the dedupe middleware does NOT cover this: it skips a duplicate of
    // an ACKED message (SKIP_COMPLETED), but a 500-NACK retry is granted RUN
    // by `reclaim_after_failure`. Three comments in this repo claimed
    // otherwise; they have been corrected.
    const publishedAt = publishTimeOf(body);
    const result = await processInternalEvents(
      payload,
      publishedAt ? { now: () => publishedAt } : undefined,
    );
    console.log(
      `[internal-events] received=${result.received} upserted=${result.upserted} ` +
        `failed=${result.failed} listingResolved=${result.listingResolved} ` +
        `observedAtFromPayload=${result.observedAtFromPayload} ` +
        `(message: ${getMessageId(body)})`,
    );
    // NOT `failed > 0 ? 500 : 200` inline. A 2xx is an ACK, and the difference
    // between acking and nacking a partially-written batch is whether those
    // events are discarded or redelivered — a decision that belongs somewhere a
    // test can drive it, not somewhere a source scan has to guess at it.
    const status = ackStatusFor(result);
    if (status !== 200) {
      console.error(
        `[internal-events] ${result.failed} of ${result.received} events failed to ` +
          "store; nacking so Pub/Sub redelivers (the upsert is keyed on eventId, " +
          "so re-running the ones that landed costs nothing)",
      );
    }
    return c.json({ success: result.failed === 0, ...result }, status);
  } catch (error) {
    if (error instanceof ZodError) {
      // 400, and the ISSUES are returned. The caller is our own Python service
      // and the request is public filing metadata — there is nothing sensitive
      // in an accession or a form string, and a bare "invalid" would send the
      // operator to read logs on the wrong side of the seam.
      console.error("[internal-events] invalid request", error.issues);
      return c.json({ error: "invalid request", issues: error.issues }, 400);
    }
    console.error("[internal-events] failed", error);
    return c.json({ error: "internal error" }, 500);
  }
});
