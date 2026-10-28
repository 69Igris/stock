import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { SectorEnrichmentMessage } from "@usemoney/types";
import { processSectorEnrichment } from "../processors/sector-enrichment";

export const sectorEnrichmentRoute = new Hono();

sectorEnrichmentRoute.post("/", async (c) => {
  try {
    // Handle empty body gracefully (direct curl with no -d flag)
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<SectorEnrichmentMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing sector enrichment job (message: ${messageId}, batchSize: ${data.batchSize ?? 100})`
    );

    await processSectorEnrichment(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Sector enrichment job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
