/**
 * Pure, side-effect-free seams for the Dodo payment-provisioning service
 * (`payment-provisioning.service.ts`).
 *
 * MONEY-1062 (W1-B): the subscription-provisioning grant that the Dodo webhook
 * route AND the browser-redirect payments/callback route both drive was
 * extracted out of `apps/web/app/api/**` into `@usemoney/services`. The two
 * routes stay thin (transport: svix verify / auth + Dodo poll / cron auth); the
 * grant — the claim-once money path — lives here so it can be contract-tested at
 * the package level.
 *
 * This file holds ONLY the pure bits (no Prisma, no `@usemoney/email`, no
 * `next/*`): payload typing, payment-error sanitisation, the Dodo subscription-id
 * extraction, and the webhook envelope→action dispatch table. The impure
 * orchestration lives in `payment-provisioning.service.ts`.
 *
 * `sanitizePaymentError` + `extractDodoSubscriptionId` were moved here verbatim
 * from the old `apps/web/app/api/webhooks/dodo/dodo-webhook-logic.ts` (which now
 * re-exports them from `@usemoney/services` for its edge-case test) — a package
 * cannot import from `apps/web`, so the single source of truth moved down.
 *
 * @see packages/services/src/payment-provisioning.service.ts
 * @see packages/services/__tests__/payment-provisioning.test.ts
 */

// ---------------------------------------------------------------------------
// Dodo webhook payload typing (replaces the routes' `any`).
// ---------------------------------------------------------------------------

/**
 * The `data` object inside a Dodo webhook envelope (and the object the callback
 * hands the grant after a Dodo `payments.retrieve`). Every field is optional —
 * Dodo's event shapes differ by type — and the index signature is load-bearing:
 * `handlePaymentCompleted` merges the WHOLE `data` object into `Payment.metadata`
 * (`{ ...metadata, ...data }`), so arbitrary keys must be carried through.
 */
export interface DodoWebhookData {
  payment_id?: string;
  subscription_id?: string;
  customer?: { customer_id?: string | null } | null;
  invoice_url?: string | null;
  invoice_id?: string | null;
  payment_method?: string | null;
  payment_method_type?: string | null;
  card_last_four?: string | null;
  card_network?: string | null;
  card_type?: string | null;
  settlement_amount?: number | string | null;
  settlement_currency?: string | null;
  /** MONEY-877: presentment currency (what the customer was charged in). */
  currency?: string | null;
  tax?: number | string | null;
  total_amount?: number | string | null;
  next_billing_date?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * The Dodo webhook envelope: `{ business_id, type, timestamp, data }`. The event
 * discriminator is `type` (dodopayments `WebhookPayload`); `event` is the legacy
 * alias kept for replay safety.
 */
export interface DodoWebhookEnvelope {
  type?: string;
  event?: string;
  business_id?: string;
  timestamp?: string;
  data: DodoWebhookData;
  [key: string]: unknown;
}

/**
 * A user row shape the provisioning service passes to the injected notifier so
 * the route can preference-gate + render the transactional email WITHOUT the
 * service importing `@usemoney/email` (kept out of `@usemoney/services` to avoid
 * the cyclic dep the package deliberately shuns — see account-deletion.service).
 */
export interface NotifiableUser {
  id: string;
  email: string;
  name: string | null;
  emailPreferences: unknown;
}

/**
 * Transactional-notification seam injected into the webhook provisioning path.
 * The Dodo WEBHOOK sends preference-gated emails + moves Resend segments; the
 * browser CALLBACK sends none (the webhook is the authoritative notify path).
 * The service invokes these at the EXACT points the inline route code did, so
 * side-effect ordering is preserved. Implementations are best-effort: email
 * sends are fire-and-forget (return void) and `moveSegment` swallows/logs its
 * own failure — matching the original route behaviour.
 */
export interface PaymentNotifier {
  /**
   * Payment-success receipt. Subject is `Payment Confirmed - ${planName}` in the
   * route impl (addon → planName "AI Query Pack"; plan → payment.planName), so a
   * single method covers both. `amount`/`currency` are the REAL charge
   * (MONEY-877). Fire-and-forget in the route (not awaited).
   */
  paymentSucceeded(input: {
    user: NotifiableUser;
    planName: string;
    amount: string;
    currency: string;
  }): void | Promise<void>;
  /** Payment-failure email with the ALREADY-sanitised error message. */
  paymentFailed(input: {
    user: NotifiableUser;
    planName: string;
    errorMessage: string;
  }): void | Promise<void>;
  /** Subscription-cancelled email. `planName` is getReadablePlanName(sub.planId). */
  subscriptionCancelled(input: {
    user: NotifiableUser;
    planName: string;
  }): void | Promise<void>;
  /** Subscription-renewed email. `planName` is getReadablePlanName(sub.planId). */
  subscriptionRenewed(input: {
    user: NotifiableUser;
    planName: string;
  }): void | Promise<void>;
  /**
   * Resend contact-segment move (free→paid on a paid grant, paid→downgraded on a
   * cancel). Awaited in the original route; the impl handles + logs its own
   * failure so a segment error never blocks/rethrows past the grant.
   */
  moveSegment(input: {
    user: NotifiableUser;
    from: string;
    to: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Payment-error sanitisation (moved verbatim from dodo-webhook-logic.ts).
// ---------------------------------------------------------------------------

/**
 * Sanitize raw payment-error text from Dodo before it is shown to a user. Raw
 * provider errors may carry internal details, keys, or stack traces, so we map
 * to a small set of safe, user-facing messages and otherwise fall back to a
 * generic line. Non-string / empty input → generic message.
 *
 * Keyword precedence (first match wins): insufficient|declined → expired →
 * cancelled|canceled → timeout|timed out → generic.
 */
export function sanitizePaymentError(raw: unknown): string {
  if (!raw || typeof raw !== "string") {
    return "Your payment could not be processed. Please try again or use a different payment method.";
  }

  const lower = raw.toLowerCase();

  if (lower.includes("insufficient") || lower.includes("declined")) {
    return "Your payment was declined. Please check your payment details or try a different method.";
  }
  if (lower.includes("expired")) {
    return "Your card has expired. Please use a different payment method.";
  }
  if (lower.includes("cancelled") || lower.includes("canceled")) {
    return "The payment was cancelled.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "The payment timed out. Please try again.";
  }

  return "Your payment could not be processed. Please try again or use a different payment method.";
}

/**
 * Resolve the Dodo subscription id for a completed payment: the value stored on
 * the Payment record's metadata at checkout takes precedence over the
 * subscription_id on the webhook body; null when neither is present.
 */
export function extractDodoSubscriptionId(
  paymentMetadata: Record<string, unknown> | null,
  webhookData: Record<string, unknown> | null | undefined,
): string | null {
  return (
    (paymentMetadata?.dodoSubscriptionId as string | undefined) ??
    (webhookData?.subscription_id as string | undefined) ??
    null
  );
}

/**
 * Coerce a Dodo money field (`number | string | null`) to a finite number, or
 * null. Dodo normally sends amounts as numbers, but a malformed / non-numeric
 * string would make `Number(...)` return `NaN` — which then persists into a money
 * column or renders as "₹NaN" in the receipt email. A bare `!= null` check does
 * NOT catch this (`Number("abc") === NaN`, `Number("x") === NaN`,
 * `Number(Infinity)` is non-finite), so every externally-sourced amount is routed
 * through here before it is written or displayed.
 *
 * MONEY-1062 (J-F3): a trimmed-EMPTY string is treated as MISSING (null), NOT 0.
 * `Number("")` and `Number("   ")` are both `0`, so an empty Dodo amount would
 * return 0 — defeating the caller's `?? payment.X` replay-preservation and letting
 * a redelivered event clobber a stored amount with 0 (receipts then show 0). Guard
 * the empty/whitespace string BEFORE `Number(...)`.
 */
export function coerceFiniteAmount(
  value: number | string | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Webhook envelope → action dispatch (pure, table-testable).
// ---------------------------------------------------------------------------

/**
 * The set of provisioning actions the Dodo webhook route dispatches to. Mirrors
 * the route's `switch (event)` 1:1; `unhandled` is the `default` branch (logged,
 * returns 200 so Dodo does not retry).
 */
export type WebhookAction =
  | "payment_completed"
  | "payment_failed"
  | "subscription_cancelled"
  | "subscription_renewed"
  | "subscription_activated"
  | "subscription_past_due"
  | "subscription_expired"
  | "refund_succeeded"
  | "unhandled";

/**
 * Map a Dodo webhook event type to its provisioning action. Case-sensitive
 * (matches the route's raw string `switch`). The legacy `payment.completed`
 * alias resolves to the same action as the spec `payment.succeeded`, and both
 * dunning events (`subscription.on_hold`, `subscription.failed`) map to
 * `subscription_past_due`. Anything else (incl. `undefined`) → `unhandled`.
 */
export function mapWebhookEvent(event: string | undefined): WebhookAction {
  switch (event) {
    case "payment.succeeded":
    case "payment.completed":
      return "payment_completed";
    case "payment.failed":
      return "payment_failed";
    case "subscription.cancelled":
      return "subscription_cancelled";
    case "subscription.renewed":
      return "subscription_renewed";
    case "subscription.active":
      return "subscription_activated";
    case "subscription.on_hold":
    case "subscription.failed":
      return "subscription_past_due";
    case "subscription.expired":
      return "subscription_expired";
    case "refund.succeeded":
      return "refund_succeeded";
    default:
      return "unhandled";
  }
}

/**
 * Outcome of the payments-callback grant, so the thin callback route can map it
 * to the right redirect WITHOUT owning any grant logic:
 *   - "granted"          — the claim was won and the grant applied → success page
 *   - "already_applied"  — the claim was lost (webhook/other tab won) → success page
 *   - "addon_ineligible" — a QUERY_PACK purchase with no subscription row or a
 *     non-PRO/PREMIUM/ULTIMATE plan → `/pricing?error=addon_requires_pro_or_unlimited`
 *   - "not_completed"    — the handed Payment row is not COMPLETED (the service
 *     re-asserts the route's guard) → `/pricing?error=payment_not_verified`
 * (Both "granted" and "already_applied" redirect to the success page, exactly as
 * the inline callback did.)
 */
export type CallbackGrantOutcome =
  | "granted"
  | "already_applied"
  | "addon_ineligible"
  | "not_completed";
