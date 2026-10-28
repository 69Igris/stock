import { Hono } from "hono";
import { getMessageId } from "../lib/message";
import { processSurveillanceSync } from "../processors/surveillance-sync";

export const surveillanceSyncRoute = new Hono();

surveillanceSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(
      `Processing surveillance sync (message: ${getMessageId(body)})`,
    );

    const result = await processSurveillanceSync();

    if (!result.ok) {
      // A framework failed to fetch or parsed to zero. 500 so Pub/Sub retries
      // — and a retry is worth having, because these endpoints serve only
      // TODAY's list and a missed day can never be backfilled.
      return c.json({ success: false, frameworks: result.frameworks }, 500);
    }
    return c.json({ success: true, frameworks: result.frameworks }, 200);
  } catch (error) {
    console.error("Surveillance sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
