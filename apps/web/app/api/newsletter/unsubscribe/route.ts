import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  verifyUnsubscribeToken,
  removeFromNewsletterAudience,
} from "@usemoney/email";
import {
  determineUnsubscribeOutcome,
  unsubscribePageHtml,
} from "./route-logic";

/**
 * Shared unsubscribe logic for GET (renders a confirmation page) and POST (RFC
 * 8058 one-click; returns a blank 200). Verifies the HMAC token, flips the
 * subscriber to UNSUBSCRIBED, and removes them from the Resend audience.
 */
async function applyUnsubscribe(
  email: string | null,
  token: string | null
): Promise<{ status: number; message: string }> {
  if (!email || !token) {
    return { status: 400, message: "Missing parameters." };
  }

  if (!verifyUnsubscribeToken(email, token)) {
    return { status: 400, message: "Invalid unsubscribe link." };
  }

  try {
    const subscriber = await prisma.newsletterSubscriber.findUnique({
      where: { email: email.toLowerCase() },
    });

    const outcome = determineUnsubscribeOutcome(
      !!subscriber,
      subscriber?.status ?? null
    );

    // Only flip + sync on the success case (exists & not already unsubscribed).
    if (subscriber && subscriber.status !== "UNSUBSCRIBED") {
      await prisma.newsletterSubscriber.update({
        where: { email: email.toLowerCase() },
        data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
      });

      // Audience-sync: remove from the newsletter audience in Resend so future
      // broadcasts don't reach this address. Fire-and-forget — the DB update
      // already succeeded; a Resend hiccup doesn't affect the response.
      removeFromNewsletterAudience({ email: email.toLowerCase() }).catch(
        (err: unknown) => {
          console.error(
            "[Newsletter Unsubscribe] Resend audience sync failed:",
            err
          );
        }
      );
    }

    return outcome;
  } catch (error) {
    console.error("[Newsletter Unsubscribe] Error:", error);
    return {
      status: 500,
      message: "Something went wrong. Please try again later.",
    };
  }
}

export async function GET(request: NextRequest) {
  const { status, message } = await applyUnsubscribe(
    request.nextUrl.searchParams.get("email"),
    request.nextUrl.searchParams.get("token")
  );
  return new Response(unsubscribePageHtml(message), {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

/**
 * RFC 8058 one-click unsubscribe. Mail clients (Gmail/Yahoo) POST to this URL
 * with the email + token in the query string; we apply the unsubscribe and
 * return a blank 200 with no body, as the spec requires.
 */
export async function POST(request: NextRequest) {
  await applyUnsubscribe(
    request.nextUrl.searchParams.get("email"),
    request.nextUrl.searchParams.get("token")
  );
  return new Response(null, { status: 200 });
}
