/**
 * Newsletter Publish Processor
 *
 * Queries for SCHEDULED newsletters whose publishDate has arrived,
 * transitions them to PUBLISHED, and sends emails via the shared
 * @usemoney/email newsletter module.
 *
 * Audience routing
 * ────────────────
 * `Post.targetSegments` can contain two kinds of values:
 *
 * 1. "newsletter" — targets the new opt-in Resend audience identified by
 *    RESEND_AUDIENCE_NEWSLETTER_ID.  A direct broadcast is issued to that
 *    audience using `sendBroadcast` from @usemoney/email.
 *
 * 2. "usemoney-free" | "usemoney-paid" | "usemoney-downgrade" | "usemoney-security"
 *    — legacy per-user-tier audiences routed via `sendNewsletterBroadcast`.
 *
 * If `targetSegments` is empty AND NEWSLETTER_AUDIENCE_ID is set the post
 * defaults to the newsletter audience.  If NEWSLETTER_AUDIENCE_ID is unset it
 * falls back to the legacy default (free + paid + downgraded) inside
 * `sendNewsletterBroadcast`.
 */

import prisma from "@usemoney/database";
import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import type { NewsletterPublishMessage } from "@usemoney/types";
import {
  routeNewsletterSend,
  sendNewsletterToIndividuals,
} from "@usemoney/email";
import type { NewsletterSendParams } from "@usemoney/email";

// MONEY-866: segment routing (splitSegments + sendToNewsletterAudience) moved to
// @usemoney/email as the shared routeNewsletterSend — see above import — so the
// worker and the immediate publishPost path can never diverge again.

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function processNewsletterPublish(
  data: NewsletterPublishMessage,
): Promise<{ published: number }> {
  const now = new Date();

  // Build query: find due SCHEDULED newsletters
  const where: Record<string, unknown> = {
    status: "SCHEDULED",
    contentType: "NEWSLETTER",
    publishDate: { lte: now },
  };

  // If a specific postId was provided, only process that one
  if (data.postId) {
    where.id = data.postId;
  }

  const duePosts = await prisma.post.findMany({
    where,
    include: {
      author: {
        select: {
          id: true,
          name: true,
          username: true,
          imageUrl: true,
        },
      },
    },
  });

  if (duePosts.length === 0) {
    console.log("[newsletter-publish] No scheduled newsletters due");
    // Genuinely idle: `selected` 0, so the zero-write monitor stays quiet. This
    // is the branch that runs on 287 of the 288 daily ticks.
    reportJobOutcome({
      job: "newsletter-publish",
      selected: 0,
      written: 0,
      skippedReason: "no SCHEDULED newsletter has reached its publishDate",
    });
    return { published: 0 };
  }

  console.log(
    `[newsletter-publish] Found ${duePosts.length} due newsletter(s)`,
  );

  let published = 0;

  for (const post of duePosts) {
    try {
      // 1. Update status to PUBLISHED
      await prisma.post.update({
        where: { id: post.id },
        data: {
          status: "PUBLISHED",
        },
      });

      console.log(
        `[newsletter-publish] Published: "${post.title}" (${post.id})`,
      );

      // 2. Build params for email sending
      const sendParams: NewsletterSendParams = {
        title: post.title,
        excerpt: post.excerpt,
        content: post.content,
        postUrl: post.postUrl,
        featureImage: post.featureImage,
        authorName: post.author?.name || undefined,
        authorImageUrl: post.author?.imageUrl || undefined,
        publishDate: post.publishDate?.toISOString(),
      };

      // 3. Route to audience(s) — the SAME shared entry the immediate
      // publishPost path uses (MONEY-866), so the two can never diverge again.
      await routeNewsletterSend(sendParams, post.targetSegments, post.id);

      // 4. Send to individual emails
      if (post.targetEmails.length > 0) {
        try {
          await sendNewsletterToIndividuals(sendParams, post.targetEmails);
        } catch (err) {
          console.error(
            `[newsletter-publish] Individual send failed for post ${post.id}:`,
            err,
          );
        }
      }

      published++;
    } catch (err) {
      console.error(
        `[newsletter-publish] Failed to process post ${post.id}:`,
        err,
      );
    }
  }

  // MONEY-1250 — `selected` is DUE newsletters, not scheduled ones.
  //
  // The zero-write monitor is `selected > 0 && written === 0`, and on a `*/5`
  // cron that is only truthful if a quiet tick selects NOTHING. `publishDate <=
  // now` is exactly that line: a post the operator scheduled for tomorrow is
  // not selected, and a post whose time HAS come is selected and stays selected
  // — the query re-finds it every five minutes until it actually publishes.
  //
  // So this is the "age of the oldest scheduled-but-unpublished newsletter"
  // signal expressed as a count, without a second mechanism to maintain: a post
  // that fails to send is re-counted 288 times a day, and every one of those
  // runs reports `selected > 0, written 0`.
  reportJobOutcome({
    job: "newsletter-publish",
    selected: duePosts.length,
    written: published,
    failed: duePosts.length - published,
    ...(published < duePosts.length
      ? {
          skippedReason:
            `${duePosts.length - published} of ${duePosts.length} due ` +
            `newsletter(s) did not publish — see the per-post error above`,
        }
      : {}),
  });

  return { published };
}
