import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { AnnualReportsSyncMessage } from "../processors/annual-reports-sync";
import { processAnnualReportsSync } from "../processors/annual-reports-sync";

export const annualReportsSyncRoute = new Hono();

annualReportsSyncRoute.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    const data = parsePubSubMessage<AnnualReportsSyncMessage>(body);
    console.log(
      `Processing annual-reports sync (message: ${getMessageId(body)})`,
    );
    await processAnnualReportsSync(data);
  } catch (error) {
    // ACK 200: each leg already catches its own failures and logs its own
    // summary; a retry would re-scrape the whole shard to recover one call.
    console.error("Annual reports sync job failed:", error);
  }
  return c.json({ success: true }, 200);
});
