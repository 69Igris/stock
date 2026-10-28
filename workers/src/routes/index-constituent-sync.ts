import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { IndexConstituentSyncMessage } from "@usemoney/types";
import { processIndexConstituentSync } from "../processors/index-constituent-sync";

export const indexConstituentSyncRoute = new Hono();

indexConstituentSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<IndexConstituentSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing index constituent sync (message: ${messageId}, indexes: ${
        data.indexes?.join(",") ?? "all"
      })`,
    );

    const result = await processIndexConstituentSync(data);

    if (!result.ok) {
      // Some indexes failed - return 500 so Pub/Sub retries.
      return c.json(
        { success: false, degraded: result.degraded, results: result.results },
        500,
      );
    }
    // MONEY-1238 — `degraded` rides the 200 body. A run where every
    // archive-covered index quietly fell back to a 2023 hand-typed array is a
    // SUCCESS by every other measure, and this is the only place the
    // substitution is visible to a caller.
    return c.json(
      { success: true, degraded: result.degraded, results: result.results },
      200,
    );
  } catch (error) {
    console.error("Index constituent sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
