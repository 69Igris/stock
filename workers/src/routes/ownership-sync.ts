import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import {
  processOwnershipSync,
  type OwnershipSyncMessage,
} from "../processors/ownership-sync";

export const ownershipSyncRoute = new Hono();

ownershipSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<OwnershipSyncMessage>(body);
    console.log(
      `Processing ownership sync job (message: ${getMessageId(body)})`,
    );

    const outcome = await processOwnershipSync(data);

    if (outcome.status === "FAILED") {
      // The response code is chosen by FAILURE CLASS, not by the verdict —
      // MONEY-1238 (#8), following the `isRetriableFailure` idiom xbrl-sync
      // established in MONEY-1200.
      //
      // Before this, `decideRunStatus`'s FAILED was LOGGED and thrown away:
      // the processor was `Promise<void>` and this handler answered a flat
      // `{success:true}, 200`, so an empty symbol queue, missing Prisma models
      // and a 0-rows-written run all ACKed as success. The catch below still
      // claimed "a failed ownership shard is worth retrying" while describing
      // a path the verdict could not reach.
      //
      // It is deliberately NOT a blanket 500. Pub/Sub redelivers on any
      // non-2xx, so a DETERMINISTIC failure — a Prisma model that will be
      // missing until the next deploy, a parser that will mis-shape the same
      // bytes the same way — would become five identical full per-symbol
      // fan-outs against NSE before the dead-letter policy caught it.
      if (outcome.retriable) {
        console.error(
          "Ownership sync FAILED transiently — 500 so Pub/Sub retries:",
          outcome.notes.join("; "),
        );
        return c.json({ success: false, ...outcome }, 500);
      }
      console.error(
        "Ownership sync FAILED deterministically — acking to avoid a retry " +
          "storm; this needs a code or schema change, not a redelivery:",
        outcome.notes.join("; "),
      );
      return c.json({ success: false, retried: false, ...outcome }, 200);
    }

    // PARTIAL is a 200 on purpose: some of the run landed, and a redelivery
    // would repeat the whole fan-out to re-attempt the part that did not. The
    // verdict, its notes and the barren legs are in the body and in the sync
    // log either way.
    if (outcome.passDaysAlert) {
      console.error(
        `Ownership sync COVERAGE ALERT: projected full pass ` +
          `${outcome.projectedPassDays?.toFixed(1)} day(s).`,
      );
    }

    return c.json({ success: true, ...outcome }, 200);
  } catch (error) {
    // 500 so Pub/Sub retries — a failed ownership shard is worth retrying, and
    // the processor is idempotent (upsert on (symbol,quarter) / dedupeKey), so a
    // redelivery rewrites the same rows rather than duplicating them.
    console.error("Ownership sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
