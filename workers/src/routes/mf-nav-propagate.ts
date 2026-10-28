import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { MfNavPropagateMessage } from "@usemoney/types";
import { processMfNavPropagate } from "../processors/mf-nav-propagate";

export const mfNavPropagateRoute = new Hono();

mfNavPropagateRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<MfNavPropagateMessage>(body);
    const messageId = getMessageId(body);

    console.log(`Processing MF NAV propagation job (message: ${messageId})`);

    await processMfNavPropagate(data);

    return c.json({ success: true }, 200);
  } catch (error) {
    console.error("MF NAV propagation job failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
