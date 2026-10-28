import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import { processStrategyStatsSync } from "../processors/strategy-stats-sync";
import type { StrategyStatsSyncMessage } from "@usemoney/types";

export const strategyStatsSyncRoute = new Hono();

strategyStatsSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<StrategyStatsSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing strategy stats sync (message: ${messageId}, ids: ${data.strategyIds?.length ?? "all"})`,
    );

    await processStrategyStatsSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Strategy stats sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
