/**
 * Pure logic for the newsletter unsubscribe route.
 *
 * Extracted from `./route.ts` (MONEY-620) so the user-facing HTML page and the
 * subscriber-status → (HTTP status, message) decision are tested against the
 * REAL exported symbols the route renders, instead of inline copies. Kept free
 * of Prisma / email-sender imports so it stays a cheap pure unit.
 *
 * @see apps/web/__tests__/newsletter/unsubscribe.test.ts
 */

/** Subscriber lifecycle states (mirrors Prisma `SubscriberStatus`). */
export type SubscriberStatus = "PENDING" | "ACTIVE" | "UNSUBSCRIBED";

export interface UnsubscribeOutcome {
  status: number;
  message: string;
}

/**
 * Decide the (HTTP status, message) for an unsubscribe attempt given whether
 * the subscriber exists and its current status. Idempotent: an already-
 * UNSUBSCRIBED record is a 200 "already unsubscribed", and a missing record is
 * a 404. Any other state is the success case (the route flips it to
 * UNSUBSCRIBED).
 */
export function determineUnsubscribeOutcome(
  subscriberExists: boolean,
  currentStatus: SubscriberStatus | null
): UnsubscribeOutcome {
  if (!subscriberExists) {
    return { status: 404, message: "Email address not found in our records." };
  }
  if (currentStatus === "UNSUBSCRIBED") {
    return { status: 200, message: "You have already been unsubscribed." };
  }
  return {
    status: 200,
    message:
      "You have been successfully unsubscribed from the UseMoney newsletter.",
  };
}

/** Render the branded unsubscribe confirmation / error HTML page. */
export function unsubscribePageHtml(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe - UseMoney</title>
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
    <h1>UseMoney Newsletter</h1>
    <p>${message}</p>
    <p><a href="https://usemoney.ai">Back to UseMoney</a></p>
  </div>
</body>
</html>`;
}
