/**
 * POST /api/broker-request
 *
 * Backs the "Request a broker" form on /integrations. Receives an email +
 * broker name from a marketing-page visitor, then in parallel:
 *
 *   1. Emails founder@usemoney.ai (via the existing transactional pipeline)
 *      with the request. Reply-To is set to the visitor's email so a single
 *      reply lands in their inbox.
 *
 *   2. Adds the visitor to the newsletter Resend audience so they receive
 *      the weekly long-read AND the eventual "<broker> is live" announcement.
 *
 * Both side-effects are best-effort: if Resend or the audience is briefly
 * unreachable, the route still returns 200 so the form doesn't dead-end on
 * the visitor.
 *
 * No DB write today — broker requests are low-volume and the founder's
 * inbox is the source of truth. If volume grows, add a BrokerRequest Prisma
 * model and dedupe by (email, brokerName).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  addToNewsletterAudience,
  EMAIL_REPLY_TO,
  sendEmail,
} from "@usemoney/email";
import { BrokerRequestTeamEmail } from "@usemoney/email/templates";
import { authRateLimiter } from "@usemoney/security/rate-limit";

// The visitor enters arbitrary text into the broker-name field. We trim and
// cap length so a pasted essay can't blow up the email body. Email is normalised
// to lower-case before any downstream use (consistent with newsletter subscribe).
const BrokerRequestSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  brokerName: z
    .string()
    .min(1, "Tell us which broker")
    .max(120, "Broker name is too long")
    .transform((s) => s.trim()),
});

export async function POST(request: NextRequest) {
  try {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0] || "anonymous";
    const userAgent = request.headers.get("user-agent") || null;

    const rate = await authRateLimiter.check(10, ip);
    if (!rate.success) {
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = BrokerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 }
      );
    }

    const email = parsed.data.email.toLowerCase();
    const brokerName = parsed.data.brokerName;
    const receivedAt = new Date().toISOString();

    // Fire both side-effects in parallel — neither blocks the other and
    // neither's failure should fail the request.
    const [emailResult, audienceResult] = await Promise.allSettled([
      sendEmail({
        to: EMAIL_REPLY_TO, // founder@usemoney.ai
        replyTo: email, // reply-from-founder reaches the requester
        subject: `Broker request: ${brokerName}`,
        template: "broker-request-team",
        react: BrokerRequestTeamEmail({
          email,
          brokerName,
          receivedAt,
          ip: ip === "anonymous" ? null : ip,
          userAgent,
        }),
      }),
      addToNewsletterAudience({ email }),
    ]);

    if (emailResult.status === "rejected") {
      // Log but don't fail — the visitor sees success either way; the team
      // missing a request once is annoying, not broken.
      console.error(
        "[broker-request] founder email failed:",
        emailResult.reason
      );
    }
    if (audienceResult.status === "rejected") {
      console.error(
        "[broker-request] newsletter add failed:",
        audienceResult.reason
      );
    } else if (
      audienceResult.value.ok === false &&
      audienceResult.value.error !== "audience-not-configured"
    ) {
      // `audience-not-configured` means RESEND_AUDIENCE_NEWSLETTER_ID isn't
      // set in this env — fine for local/dev; only worth logging in prod.
      console.warn(
        "[broker-request] newsletter add returned not-ok:",
        audienceResult.value.error
      );
    }

    return NextResponse.json(
      {
        ok: true,
        message: "Added to the waitlist. We'll email you when it ships.",
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[broker-request] unexpected error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 500 }
    );
  }
}
