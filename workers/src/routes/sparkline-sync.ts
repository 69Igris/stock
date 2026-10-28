import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { SparklineSyncMessage } from "@usemoney/types";
import { processSparklineSync } from "../processors/sparkline-sync";

export const sparklineSyncRoute = new Hono();

sparklineSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<SparklineSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing sparkline sync job (message: ${messageId}, windows: ${
        (data.windows ?? ["1D", "1W"]).join(",")
      }, symbols: ${data.symbols?.length ?? "universe"})`,
    );

    await processSparklineSync(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("Sparkline sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
