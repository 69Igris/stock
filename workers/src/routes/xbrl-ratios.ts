import { Hono } from "hono";
import { getMessageId, parsePubSubMessage } from "../lib/message";
import {
  processXbrlRatios,
  type XbrlRatiosMessage,
} from "../processors/xbrl-ratios";

export const xbrlRatiosRoute = new Hono();

xbrlRatiosRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    console.log(`Processing XBRL ratios (message: ${getMessageId(body)})`);

    // DECODE THE ENVELOPE — MONEY-1235, same defect as the projection route.

    // Over Pub/Sub the body is the envelope, so `apply`/`limit`/`symbols`

    // read straight off it are all `undefined`. `parsePubSubMessage` falls

    // back to the body when it is not an envelope, so direct invocation is

    // unaffected.

    const raw = (parsePubSubMessage<Record<string, unknown>>(body) ??
      {}) as Record<string, unknown>;
    const msg: XbrlRatiosMessage = {
      // Narrows only — the env is the arm. Same rule as xbrl-projection.
      apply: typeof raw.apply === "boolean" ? raw.apply : undefined,
      limit:
        typeof raw.limit === "number" && Number.isFinite(raw.limit)
          ? raw.limit
          : undefined,
      symbols: Array.isArray(raw.symbols)
        ? raw.symbols.filter((s): s is string => typeof s === "string")
        : undefined,
    };

    const result = await processXbrlRatios(msg);
    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("XBRL ratios failed:", error);
    // 500 so Pub/Sub redelivers. Safe: the write is an upsert on
    // (symbol, exchange) and every value is recomputed from the same filing and
    // close, so a redelivery produces identical rows.
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "unknown",
      },
      500,
    );
  }
});
