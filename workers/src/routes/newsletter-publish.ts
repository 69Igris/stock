/**
 * Newsletter Publish Worker Route
 *
 * Receives Pub/Sub messages (typically from Cloud Scheduler every 5 min)
 * and publishes any SCHEDULED newsletters whose publishDate has arrived.
 */

import { Hono } from "hono";
import { parsePubSubMessage, getMessageId } from "../lib/message";
import type { NewsletterPublishMessage } from "@usemoney/types";
import { processNewsletterPublish } from "../processors/newsletter-publish";

export const newsletterPublishRoute = new Hono();

newsletterPublishRoute.post("/", async (c) => {
  try {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const data = parsePubSubMessage<NewsletterPublishMessage>(body);
    const messageId = getMessageId(body);

    console.log(
      `[newsletter-publish] Processing (message: ${messageId})${data.postId ? ` postId=${data.postId}` : ""}`,
    );

    const result = await processNewsletterPublish(data);

    console.log(
      `[newsletter-publish] Done - published ${result.published} newsletter(s)`,
    );

    return c.json({ success: true, ...result }, 200);
  } catch (error) {
    console.error("[newsletter-publish] Failed:", error);
    return c.json({ error: "Processing failed" }, 500);
  }
});
