/**
 * Shared newsletter sending logic.
 *
 * Used by both:
 * - apps/content publishPost() for immediate publishing
 * - workers newsletter-publish processor for scheduled newsletters
 */

import React from "react";
import { prisma } from "@usemoney/database";
import { sendBroadcast, sendBroadcastToSegments } from "./broadcast";
import { sendEmail } from "./send";
import { blocknoteToEmailHtml } from "./blocknote-to-email";
import { generateUnsubscribeToken } from "./tokens";
import {
  APP_URL,
  NEWSLETTER_AUDIENCE_ID,
  EMAIL_SEGMENTS,
  WEB_APP_URL,
} from "./constants";
import { NewsletterIssueEmail } from "./templates/newsletter-issue";
import type { Segment } from "./contacts";

export interface NewsletterSendParams {
  title: string;
  excerpt: string | null;
  content: string; // BlockNote JSON
  postUrl: string; // slug, not full URL
  featureImage?: string | null;
  authorName?: string;
  authorImageUrl?: string;
  publishDate?: string;
}

/**
 * Send a newsletter to Resend audience segments via broadcast.
 */
export async function sendNewsletterBroadcast(
  params: NewsletterSendParams,
  segments: string[],
) {
  const {
    title,
    excerpt,
    content,
    postUrl,
    featureImage,
    authorName,
    authorImageUrl,
    publishDate,
  } = params;

  // View-on-website must resolve to the WEB app for the sending env (QA post on
  // qa.usemoney.ai, not prod) — same var as the other email links. (MONEY-887)
  const webUrl = WEB_APP_URL;
  const fullPostUrl = `${webUrl}/newsletter/${postUrl}`;
  const contentHtml = blocknoteToEmailHtml(content);

  // Default to free + paid + downgraded if no segments specified (skips security,
  // which is for transactional/account emails only, not newsletters).
  const selectedSegments =
    segments.length > 0
      ? segments
      : ["usemoney-free", "usemoney-paid", "usemoney-downgrade"];

  // Map segment names to Resend audience types
  const resendSegments: Segment[] = [];
  if (selectedSegments.includes("usemoney-free")) resendSegments.push("free");
  if (selectedSegments.includes("usemoney-paid")) resendSegments.push("paid");
  if (selectedSegments.includes("usemoney-downgrade"))
    resendSegments.push("downgraded");
  if (selectedSegments.includes("usemoney-security"))
    resendSegments.push("usemoney-security");
  // "marketing" is funneled here by routeNewsletterSend (it is NOT the opt-in
  // "newsletter" audience). The publish dialog / EMAIL_SEGMENTS emit it WITHOUT
  // the usemoney- prefix the tier tokens use; accept the prefixed spelling too
  // for parity. Without this branch a marketing-only broadcast resolved to no
  // segments and silently reached nobody.
  if (
    selectedSegments.includes("marketing") ||
    selectedSegments.includes("usemoney-marketing")
  )
    resendSegments.push("marketing");

  if (resendSegments.length === 0) return;

  const broadcastResults = await sendBroadcastToSegments({
    segments: resendSegments,
    subject: title,
    buildReact: (segment) =>
      React.createElement(NewsletterIssueEmail, {
        title,
        excerpt: excerpt || "",
        // Broadcasts get Resend's per-contact substitution (falls back to "there").
        firstName: "{{{contact.first_name|there}}}",
        slug: postUrl,
        postUrl: fullPostUrl,
        unsubscribeUrl:
          segment === "usemoney-security"
            ? ""
            : "{{{ RESEND_UNSUBSCRIBE_URL }}}",
        hideUnsubscribe: segment === "usemoney-security",
        contentHtml,
        featureImage,
        authorName,
        authorImageUrl,
        publishDate,
      }),
    name: title,
  });

  // Log broadcast results
  for (let i = 0; i < resendSegments.length; i++) {
    const seg = resendSegments[i];
    const result = broadcastResults[i];
    try {
      await prisma.emailLog.create({
        data: {
          to: `segment:${seg}`,
          subject: title,
          template: "newsletter-broadcast",
          status: result?.success ? "SENT" : "FAILED",
          metadata: {
            segment: seg,
            broadcastId: result?.broadcastId || null,
          },
        },
      });
    } catch (logErr) {
      console.error("[Newsletter] Failed to log broadcast:", logErr);
    }
  }

  console.log(
    `[Newsletter] Broadcasts sent for segments: ${resendSegments.join(", ")}`,
  );
}

/**
 * Send a newsletter to specific individual email addresses.
 */
export async function sendNewsletterToIndividuals(
  params: NewsletterSendParams,
  emails: string[],
) {
  const {
    title,
    excerpt,
    content,
    postUrl,
    featureImage,
    authorName,
    authorImageUrl,
    publishDate,
  } = params;

  // View-on-website must resolve to the WEB app for the sending env (QA post on
  // qa.usemoney.ai, not prod) — same var as the other email links. (MONEY-887)
  const webUrl = WEB_APP_URL;
  const fullPostUrl = `${webUrl}/newsletter/${postUrl}`;
  const contentHtml = blocknoteToEmailHtml(content);

  // Batch-resolve recipient first names in ONE query (individual sends don't get
  // Resend's per-contact merge-tag substitution, so we render the name ourselves).
  const nameByEmail = new Map<string, string>();
  try {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { email: true, name: true },
    });
    for (const u of users) {
      const first = u.name?.trim().split(/\s+/)[0];
      if (first) nameByEmail.set(u.email, first);
    }
  } catch (err) {
    console.warn("[Newsletter] first-name lookup failed — using 'there'", err);
  }

  // MONEY-864: each address goes out as its OWN direct email (resend.emails.send
  // via sendEmail) — NOT the batch or broadcast/audience path. Every recipient
  // gets a personalized unsubscribe link, independent retry, and per-email
  // success tracking.
  let sent = 0;
  let failed = 0;
  for (const email of emails) {
    let unsubscribeUrl = "";
    try {
      const token = generateUnsubscribeToken(email);
      unsubscribeUrl = `${APP_URL}/api/newsletter/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
    } catch {
      console.warn(
        "[Newsletter] EMAIL_UNSUBSCRIBE_SECRET not configured - unsubscribe links disabled",
      );
    }

    const result = await sendEmail({
      to: email,
      subject: title,
      template: "newsletter-individual",
      // RFC 8058 one-click header for this bulk send (Gmail/Yahoo requirement).
      unsubscribeUrl: unsubscribeUrl || undefined,
      react: React.createElement(NewsletterIssueEmail, {
        title,
        excerpt: excerpt || "",
        firstName: nameByEmail.get(email),
        slug: postUrl,
        postUrl: fullPostUrl,
        unsubscribeUrl,
        contentHtml,
        featureImage,
        authorName,
        authorImageUrl,
        publishDate,
      }),
    });
    if (result.success) sent++;
    else failed++;
  }

  // Log results
  try {
    await prisma.emailLog.create({
      data: {
        to: `individual:${emails.length}`,
        subject: title,
        template: "newsletter-individual",
        status: failed > 0 && sent === 0 ? "FAILED" : "SENT",
        metadata: {
          sent,
          failed,
          emailCount: emails.length,
        },
      },
    });
  } catch (logErr) {
    console.error("[Newsletter] Failed to log individual send:", logErr);
  }

  console.log(
    `[Newsletter] Individual emails sent: ${sent} delivered, ${failed} failed (${emails.length} total)`,
  );
}

// ---------------------------------------------------------------------------
// MONEY-866: shared segment routing — the SINGLE entry point both the immediate
// publishPost path AND the scheduled worker use, so they can never diverge again.
// (The immediate path used to call only sendNewsletterBroadcast, which silently
// no-ops on the "newsletter" token — only the worker routed it — so an
// immediately-published newsletter reached NOBODY.)
// ---------------------------------------------------------------------------

/** Segment ids (from the registry) that route to the opt-in newsletter audience. */
const NEWSLETTER_SEGMENT_IDS = new Set(
  EMAIL_SEGMENTS.filter((s) => s.id === "newsletter").map((s) => s.id),
);

/**
 * Split `targetSegments` into the opt-in "newsletter" audience flag and the
 * remaining legacy per-tier segments (free / paid / downgrade / security). Pure.
 */
export function splitNewsletterSegments(targetSegments: string[]): {
  hasNewsletter: boolean;
  legacySegments: string[];
} {
  let hasNewsletter = false;
  const legacySegments: string[] = [];
  for (const seg of targetSegments) {
    if (NEWSLETTER_SEGMENT_IDS.has(seg)) hasNewsletter = true;
    else legacySegments.push(seg);
  }
  return { hasNewsletter, legacySegments };
}

/**
 * Send one Resend broadcast to the opt-in newsletter audience
 * (RESEND_AUDIENCE_NEWSLETTER_ID). No-op (logged) when the audience is unset.
 */
async function sendToNewsletterAudience(
  params: NewsletterSendParams,
  audienceId: string,
  postId?: string,
): Promise<void> {
  if (!audienceId) {
    console.warn(
      `[Newsletter] RESEND_AUDIENCE_NEWSLETTER_ID not set — skipping newsletter audience${postId ? ` for post ${postId}` : ""}`,
    );
    return;
  }
  // View-on-website must resolve to the WEB app for the sending env (QA post on
  // qa.usemoney.ai, not prod) — same var as the other email links. (MONEY-887)
  const webUrl = WEB_APP_URL;
  const fullPostUrl = `${webUrl}/newsletter/${params.postUrl}`;
  const contentHtml = blocknoteToEmailHtml(params.content);

  const result = await sendBroadcast({
    audienceId,
    subject: params.title,
    react: React.createElement(NewsletterIssueEmail, {
      title: params.title,
      excerpt: params.excerpt || "",
      firstName: "{{{contact.first_name|there}}}",
      slug: params.postUrl,
      postUrl: fullPostUrl,
      unsubscribeUrl: "{{{ RESEND_UNSUBSCRIBE_URL }}}",
      contentHtml,
      featureImage: params.featureImage,
      authorName: params.authorName,
      authorImageUrl: params.authorImageUrl,
      publishDate: params.publishDate,
    }),
    name: params.title,
  });
  console.log(
    `[Newsletter] Newsletter-audience broadcast ${result.success ? "sent" : "FAILED"}${postId ? ` for post ${postId}` : ""}` +
      (result.broadcastId ? ` (broadcastId: ${result.broadcastId})` : ""),
  );
}

/**
 * MONEY-866: route a newsletter send to BOTH the opt-in "newsletter" audience AND
 * the legacy per-tier segments. THE FIX for the immediate-publish no-op — both the
 * content publishPost path and the scheduled worker now go through this one entry.
 */
export async function routeNewsletterSend(
  params: NewsletterSendParams,
  segments: string[],
  postId?: string,
): Promise<void> {
  const tag = postId ? ` for post ${postId}` : "";
  // Each audience is independent — one failing must not block the other.
  const toAudience = () =>
    sendToNewsletterAudience(params, NEWSLETTER_AUDIENCE_ID, postId).catch(
      (err) =>
        console.error(
          `[Newsletter] Newsletter-audience send failed${tag}:`,
          err,
        ),
    );
  const toLegacy = (segs: string[]) =>
    sendNewsletterBroadcast(params, segs).catch((err) =>
      console.error(`[Newsletter] Broadcast send failed${tag}:`, err),
    );

  // No explicit selection: prefer the opt-in newsletter audience when configured,
  // else the legacy default tiers (free+paid+downgrade) — matches the worker.
  if (segments.length === 0) {
    await (NEWSLETTER_AUDIENCE_ID ? toAudience() : toLegacy([]));
    return;
  }
  const { hasNewsletter, legacySegments } = splitNewsletterSegments(segments);
  if (hasNewsletter) await toAudience();
  if (legacySegments.length > 0) await toLegacy(legacySegments);
}
