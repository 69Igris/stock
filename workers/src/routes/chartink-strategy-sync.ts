import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ChartinkStrategySyncMessage } from "../processors/chartink-strategy-sync";
import { processChartinkStrategySync } from "../processors/chartink-strategy-sync";

export const chartinkStrategySyncRoute = new Hono();

chartinkStrategySyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ChartinkStrategySyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing chartink strategy sync (message: ${messageId})`);

    await processChartinkStrategySync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Chartink strategy sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
