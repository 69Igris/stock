/**
 * Strategy Scan Worker Route
 *
 * Receives Pub/Sub messages for strategy scan jobs
 * and delegates to the strategy-scan processor.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { StrategyScanMessage } from "@usemoney/types";
import { processStrategyScan } from "../processors/strategy-scan";

export const strategyScanRoute = new Hono();

strategyScanRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StrategyScanMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing strategy-scan job scan=${data.scanId} strategy=${data.strategyId} (message: ${messageId})`,
    );

    await processStrategyScan(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    // Always return 200 - processor handles errors internally.
    console.error("Strategy scan job failed:", error);
    return c.json({ success: true, recovered: true }, 200);
  }
});
