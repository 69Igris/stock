import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { MacroSyncMessage } from "@usemoney/types/pubsub";
import { processMacroSync } from "../processors/macro-sync";

export const macroSyncRoute = new Hono();

macroSyncRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<MacroSyncMessage>(body);

    console.log(
      `Processing macro sync (message: ${getMessageId(body)}, ` +
        `sources: ${data.sourceIds?.join(",") ?? "all"})`,
    );

    const result = await processMacroSync(data);

    if (!result.ok) {
      // A source failed to fetch, had no recognisable table, or parsed to zero
      // tracked series. 500 so Pub/Sub retries — worth having, because the RBI
      // pages are rolling windows and the forex page in particular shows ONE
      // week, so a run lost to a transient failure is a week lost outright.
      //
      // A STALE source does NOT reach here: staleness is reported inside the
      // result and logged at error level, because retrying cannot un-freeze a
      // discontinued page and a permanent 500 is how a retry storm starts.
      return c.json({ success: false, sources: result.sources }, 500);
    }
    return c.json({ success: true, sources: result.sources }, 200);
  } catch (error) {
    console.error("Macro sync failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
