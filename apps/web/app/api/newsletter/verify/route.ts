import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  sendEmail,
  generateUnsubscribeToken,
  addToNewsletterAudience,
} from "@usemoney/email";
import { NewsletterWelcomeEmail } from "@usemoney/email/templates";
import React from "react";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(
      new URL("/newsletter?error=missing-token", request.url)
    );
  }

  try {
    const subscriber = await prisma.newsletterSubscriber.findFirst({
      where: { verifyToken: token },
    });

    if (!subscriber) {
      return NextResponse.redirect(
        new URL("/newsletter?error=invalid-token", request.url)
      );
    }

    if (subscriber.status === "ACTIVE") {
      return NextResponse.redirect(
        new URL("/newsletter?verified=true", request.url)
      );
    }

    // Activate subscription
    await prisma.newsletterSubscriber.update({
      where: { id: subscriber.id },
      data: {
        status: "ACTIVE",
        subscribedAt: new Date(),
        verifyToken: null,
      },
    });

    // Send welcome email
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";
    // MONEY-885: token-gen must be non-fatal. generateUnsubscribeToken throws
    // when EMAIL_UNSUBSCRIBE_SECRET is unset; left unguarded it strands the
    // just-activated subscriber (status flipped to ACTIVE above) before the
    // addToNewsletterAudience sync below runs. Mirror packages/email/src/newsletter.ts.
    let unsubscribeUrl = "";
    try {
      const unsubToken = generateUnsubscribeToken(subscriber.email);
      unsubscribeUrl = `${appUrl}/api/newsletter/unsubscribe?email=${encodeURIComponent(subscriber.email)}&token=${unsubToken}`;
    } catch {
      console.warn(
        "[Newsletter Verify] EMAIL_UNSUBSCRIBE_SECRET not configured - unsubscribe links disabled"
      );
    }

    const welcomeFirstName =
      (subscriber.name || "").trim().split(" ")[0] || undefined;
    sendEmail({
      to: subscriber.email,
      subject: "Welcome to UseMoney Newsletter!",
      react: React.createElement(NewsletterWelcomeEmail, {
        unsubscribeUrl,
        name: welcomeFirstName,
      }),
      template: "newsletter-welcome",
    });

    // MONEY-864: sync the verified subscriber to the NEWSLETTER audience
    // (reads RESEND_AUDIENCE_NEWSLETTER_ID; idempotent upsert). Confirm is the
    // definitive add point — verified == in the broadcast audience.
    // Fire-and-forget; verification still succeeds if Resend hiccups.
    const [vFirst, ...vRest] = (subscriber.name || "").trim().split(" ");
    addToNewsletterAudience({
      email: subscriber.email,
      firstName: vFirst || undefined,
      lastName: vRest.length > 0 ? vRest.join(" ") : undefined,
    }).catch((err: unknown) => {
      console.error("[Newsletter Verify] Resend audience sync failed:", err);
    });

    return NextResponse.redirect(
      new URL("/newsletter?verified=true", request.url)
    );
  } catch (error) {
    console.error("[Newsletter Verify] Error:", error);
    return NextResponse.redirect(
      new URL("/newsletter?error=verification-failed", request.url)
    );
  }
}
