/**
 * Intent Learning Worker Route
 *
 * Receives Pub/Sub messages (daily Cloud Scheduler trigger)
 * and delegates to the intent learning processor.
 */

import { Hono } from "hono";
import { processIntentLearning } from "../processors/intent-learning";

export const intentLearningRoute = new Hono();

intentLearningRoute.post("/", async (c) => {
  try {
    console.log("Processing intent-learning job");
    await processIntentLearning();
    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Intent learning job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
