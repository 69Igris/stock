import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { ReportArchiveSyncMessage } from "@usemoney/types/pubsub";
import { processReportArchiveSync } from "../processors/report-archive-sync";

export const reportArchiveSyncRoute = new Hono();

reportArchiveSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<ReportArchiveSyncMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `Processing report archive sync job (message: ${messageId}, ` +
        `date: ${data.date ?? "latest"}, cadence: ${data.cadence ?? "daily"}, ` +
        `driftGuard: ${data.driftGuard === true})`,
    );

    await processReportArchiveSync(data);

    return c.json({ success: true }, 200); // 200 = ack message
  } catch (error) {
    console.error("Report archive sync job failed:", error);
    return c.json({ error: "Processing failed" }, 500); // 500 = Pub/Sub retries
  }
});
