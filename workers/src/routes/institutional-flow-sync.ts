import { Hono } from "hono";
import { getMessageId } from "../lib/message";
import { processInstitutionalFlowSync } from "../processors/institutional-flow-sync";

export const institutionalFlowSyncRoute = new Hono();

institutionalFlowSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(
      `Processing institutional flow sync (message: ${getMessageId(body)})`,
    );

    const result = await processInstitutionalFlowSync();

    if (!result.ok) {
      // The fetch failed or the payload parsed to zero rows. 500 so Pub/Sub
      // retries — and the retry genuinely matters here, unlike on the ACK-200
      // routes: /api/fiidiiTradeReact serves only the CURRENT reading, so a
      // day abandoned after one failed attempt can never be backfilled.
      return c.json({ success: false, ...result }, 500);
    }
    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("Institutional flow sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
