import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * One-click "Was this email useful?" feedback endpoint.
 *
 * Linked from the feedback widget in transactional/newsletter emails:
 *   GET /api/email/feedback?t=<template>&v=up|down
 *
 * No auth — these are unauthenticated one-click links opened straight from an
 * email client. The vote is recorded fire-and-forget on the existing EmailLog
 * model (no new Prisma model / no db push), and every request — valid or not —
 * returns the same friendly cream-themed thank-you page so a malformed link can
 * never surface an error to the reader.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const t = sp.get("t");
  const v = sp.get("v");

  // Validate: v must be "up" | "down" and t must be a non-empty template name.
  // The `if` (rather than a boolean flag) narrows t -> string and v -> "up"|"down"
  // for the metadata payload below.
  if ((v === "up" || v === "down") && t && t.trim().length > 0) {
    // Fire-and-forget: a logging failure must never fail the response.
    try {
      await prisma.emailLog.create({
        data: {
          to: "email-feedback",
          subject: `feedback:${t}:${v}`,
          template: "email-feedback",
          status: "SENT",
          metadata: { template: t, useful: v === "up" },
        },
      });
    } catch (error) {
      console.error("[Email Feedback] Failed to record feedback:", error);
    }
  }

  return new Response(feedbackPageHtml(), {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}

function feedbackPageHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Thanks for the feedback - UseMoney</title>
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
    <h1>Thanks for the feedback!</h1>
    <p>We've noted your response. Every bit of feedback helps us make UseMoney emails better.</p>
    <p><a href="https://usemoney.ai">Back to UseMoney</a></p>
  </div>
</body>
</html>`;
}
