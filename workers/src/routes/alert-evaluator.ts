import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import {
  processAlertEvaluator,
  type AlertEvaluatorMessage,
} from "../processors/alert-evaluator";

export const alertEvaluatorRoute = new Hono();

alertEvaluatorRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<AlertEvaluatorMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing alert evaluator (message: ${messageId}, scope: ${data.userId ?? "all"})`,
    );

    const result = await processAlertEvaluator(data);

    if (!result.ok) {
      // The response code is chosen by FAILURE CLASS, the house idiom from
      // routes/xbrl-sync.ts — MONEY-1238.
      //
      // TRANSIENT (a Prisma read rejected, or a notification write failed):
      // 500 so Pub/Sub retries. Safe and cheap. A redelivery re-reads
      // `lastFiredAt`, so every alert that already fired is suppressed by the
      // cooldown; the alerts table is small; and nothing here leaves the
      // process except Prisma, so a retry costs no upstream anything. Worth
      // having, because these reads are how the evaluator sees the market — a
      // swallowed rejection makes a live ASM entry indistinguishable from an
      // empty table, for every user at once.
      //
      // DETERMINISTIC (an alert's own evaluation threw): 200. A malformed
      // `conditions` payload throws identically on every attempt, the loop
      // already steps over it, and this cron fires again in sixty seconds. Five
      // redeliveries would buy nothing and cost a dead-letter alert.
      if (result.retriable) {
        return c.json({ success: false, ...result }, 500);
      }
      console.error(
        "Alert evaluator FAILED deterministically — acking to avoid a retry " +
          `storm on a per-minute cron: ${result.reason}`,
      );
      return c.json({ success: false, retried: false, ...result }, 200);
    }

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("Alert evaluator failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
