import { NextRequest } from "next/server";
import { type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  verifyUnsubscribeToken,
  getEffectivePreferences,
  type EmailPreferences,
} from "@usemoney/email";

const VALID_CATEGORIES: Array<keyof EmailPreferences> = [
  "brokerNotifications",
  "tradeAlerts",
  "paymentNotifications",
  "aiInsights",
  "marketingEmails",
];

/**
 * Shared per-category opt-out logic for GET (confirmation page) and POST (RFC
 * 8058 one-click; blank 200). Verifies the HMAC token and flips a single
 * EmailPreferences category to false.
 */
async function applyPreferenceUnsubscribe(
  email: string | null,
  token: string | null,
  category: string | null
): Promise<{ status: number; message: string }> {
  if (!email || !token || !category) {
    return { status: 400, message: "Missing parameters." };
  }

  if (!VALID_CATEGORIES.includes(category as keyof EmailPreferences)) {
    return { status: 400, message: "Invalid category." };
  }

  if (!verifyUnsubscribeToken(email, token)) {
    return { status: 400, message: "Invalid unsubscribe link." };
  }

  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true, emailPreferences: true },
    });

    if (!user) {
      return {
        status: 404,
        message: "Email address not found in our records.",
      };
    }

    const prefs = getEffectivePreferences(user.emailPreferences);
    const prefKey = category as keyof EmailPreferences;

    if (!prefs[prefKey]) {
      return {
        status: 200,
        message: `You have already unsubscribed from ${formatCategory(prefKey)} emails.`,
      };
    }

    prefs[prefKey] = false;

    await prisma.user.update({
      where: { id: user.id },
      data: { emailPreferences: prefs as unknown as Prisma.InputJsonValue },
    });

    return {
      status: 200,
      message:
        `You have been unsubscribed from ${formatCategory(prefKey)} emails. ` +
        `You can manage all your email preferences in <a href="https://usemoney.ai/settings">Settings → Notifications</a>.`,
    };
  } catch (error) {
    console.error("[Email Preferences Unsubscribe] Error:", error);
    return {
      status: 500,
      message: "Something went wrong. Please try again later.",
    };
  }
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const { status, message } = await applyPreferenceUnsubscribe(
    sp.get("email"),
    sp.get("token"),
    sp.get("category")
  );
  return htmlResponse(message, status);
}

/**
 * RFC 8058 one-click unsubscribe. Mail clients POST here with email/token/
 * category in the query string; we apply the opt-out and return a blank 200.
 */
export async function POST(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  await applyPreferenceUnsubscribe(
    sp.get("email"),
    sp.get("token"),
    sp.get("category")
  );
  return new Response(null, { status: 200 });
}

function formatCategory(category: keyof EmailPreferences): string {
  const labels: Record<keyof EmailPreferences, string> = {
    brokerNotifications: "broker notification",
    tradeAlerts: "trade alert",
    paymentNotifications: "payment & subscription",
    aiInsights: "AI insight",
    marketingEmails: "marketing",
    tipsEducation: "tips & education",
    partnerOffers: "partner offers",
    usageAnalytics: "usage analytics",
  };
  return labels[category] || category;
}

function htmlResponse(message: string, status: number) {
  return new Response(unsubscribePageHtml(message), {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

function unsubscribePageHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Email Preferences - UseMoney</title>
  <style>
    body { font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f7f3e6; color: #1d1d1b; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
    .card { background: #fbf8eb; border: 1px solid rgba(29,29,27,0.12); border-radius: 14px; padding: 40px; max-width: 420px; text-align: center; box-shadow: 3px 3px 0 #1d1d1b; }
    h1 { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; color: #1d1d1b; margin: 0 0 14px; }
    p { color: #3a3a35; font-size: 14px; line-height: 1.6; margin: 8px 0; }
    a { color: #0f7a34; text-decoration: none; font-weight: 600; }
    @media (prefers-color-scheme: dark) {
      body { background: #16140e; color: #f4ede0; }
      .card { background: #1f1c14; border-color: rgba(244,237,224,0.14); box-shadow: 3px 3px 0 #000; }
      h1 { color: #f4ede0; }
      p { color: #d8d1c4; }
      a { color: #34d399; }
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>UseMoney Email Preferences</h1>
    <p>${message}</p>
    <p><a href="https://usemoney.ai">Back to UseMoney</a></p>
  </div>
</body>
</html>`;
}
