/**
 * US Filing Insight Route — MONEY-1324 (P17).
 *
 * ONE TOPIC, TWO MESSAGE SHAPES, mounted at `/jobs/us-filing-insight`. The path
 * MUST equal the topic base name: `setup-pubsub.sh` builds the push endpoint as
 * `${SERVICE_URL}/jobs/${BASE_TOPIC}`, so a route under any other path 404s
 * every delivery and dead-letters after five attempts — which reads as a
 * failing job rather than a misrouted topic (MONEY-1257).
 *
 *   {"mode":"sweep"}        Cloud Scheduler, every 10 minutes. Diffs the cohort
 *                           against `us_filing_insights` and fans out one
 *                           message per owed document onto THIS SAME topic.
 *   {"documentId":"..."}    one document: read its extracted text, analyse it,
 *                           upsert one row.
 *
 * A message carrying NEITHER is ACKed and ignored. It is deliberately NOT read
 * as a sweep: inferring "sweep the whole cohort" from an absent field would let
 * one malformed leaf trigger an unintended fan-out of PAID model calls.
 *
 * ## ACKs 200 on every path INCLUDING a throw
 *
 * Pub/Sub ACKs only on 2xx, and every failure class in this lane is either
 * deterministic (a document with no readable text fails identically forever) or
 * expensive to repeat (a model call that already spent tokens). A redelivery
 * would re-spend for a document whose row already records what happened.
 *
 * The consequence is stated rather than left implicit: because nothing is ever
 * redelivered, THE TRANSPORT IS NOT THE RETRY CHANNEL. The `insightStatus`
 * column is — a leaf failure writes `FAILED`, and the sweep re-selects `FAILED`
 * (after a cooldown). MONEY-1314's black hole was a status no query selected,
 * so one model blip dropped a document permanently.
 *
 * ## THE ANALYSER IS INJECTED HERE
 *
 * `processUsFilingInsight` defaults its `FilingTextAnalyser` to a stub that
 * THROWS — deliberately, so an unwired deployment fails loudly rather than
 * stamping READY across the cohort. This route is the ONLY place that resolves
 * it to the real one, so an un-injected leaf is not a possibility a reader has
 * to hold in their head; it is a route that would not compile the same way.
 *
 * Constructed PER REQUEST rather than into a module const. It costs a closure,
 * and module-scope run state on a warm Cloud Run container is the shape
 * MONEY-1238 fixed in `stock-document-sync`.
 *
 * `US_FILING_INSIGHT_APPLY` still ships "false" in both specs, and that is a
 * DEPLOY decision rather than an unfinished wire: every leaf spends a paid
 * model call, so the founder arms it once the disarmed sweep has reported a
 * queue depth to arm against. Disarmed, the sweep still selects and still
 * measures; it just publishes nothing, and this route refuses a leaf that
 * arrives by any other path.
 */

import { Hono } from "hono";

import { getMessageId, parsePubSubMessage } from "../lib/message";
import {
  classifyFilingInsightMessage,
  isFilingInsightArmed,
  US_FILING_INSIGHT_APPLY_ENV,
} from "../processors/filing-insight-sweep-logic";
import {
  processFilingInsightSweep,
  type FilingInsightSweepMessage,
} from "../processors/filing-insight-sweep";
import { createFilingInsightAnalyser } from "../processors/us-filing-insight-analyser";
import {
  processUsFilingInsight,
  type UsFilingInsightMessage,
} from "../processors/us-filing-insight";

export const usFilingInsightRoute = new Hono();

usFilingInsightRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<unknown>(body);
    const messageId = getMessageId(body);
    const kind = classifyFilingInsightMessage(data);

    if (kind === "ignore") {
      console.warn(
        `[us-filing-insight] message ${messageId} names neither a documentId ` +
          'nor mode:"sweep" — acking rather than burning five deliveries on a ' +
          "message that can never succeed",
      );
      return c.json({ success: true, skipped: "unrecognised message" }, 200);
    }

    if (kind === "sweep") {
      const outcome = await processFilingInsightSweep(
        data as FilingInsightSweepMessage,
      );
      return c.json({ success: true, outcome }, 200);
    }

    // A LEAF. Refused while the lane is disarmed, and this is not belt-and-
    // braces for its own sake: the sweep is not the only way a leaf can arrive
    // (a hand-published message, a message already in flight when the flag was
    // turned off), and every leaf spends a model call.
    if (!isFilingInsightArmed()) {
      console.warn(
        `[us-filing-insight] ${messageId} refused — ` +
          `${US_FILING_INSIGHT_APPLY_ENV} is not "true"`,
      );
      return c.json({ success: true, skipped: "disarmed" }, 200);
    }

    const message = data as UsFilingInsightMessage;
    console.log(
      `Processing us filing insight ${message.documentId} (message: ${messageId})`,
    );
    const outcome = await processUsFilingInsight(message, {
      analyser: createFilingInsightAnalyser(),
    });
    return c.json({ success: true, outcome }, 200);
  } catch (error) {
    console.error("US filing insight failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
