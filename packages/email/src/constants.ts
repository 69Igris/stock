export const EMAIL_FROM =
  process.env.EMAIL_FROM || "Shaswat Deep <shaswat@email.usemoney.ai>";
export const EMAIL_REPLY_TO =
  process.env.EMAIL_REPLY_TO || "founder@usemoney.ai";
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://usemoney.ai";
// The user-facing web app (usemoney.ai). Distinct from APP_URL, which is the
// SENDING app's origin (e.g. content.usemoney.ai for newsletter broadcasts) —
// footer links like "Manage preferences" must resolve to the web app, not the
// sender.
export const WEB_APP_URL =
  process.env.NEXT_PUBLIC_WEB_APP_URL || "https://usemoney.ai";
// Terminal Luxe brand mark - emerald-gradient rounded-square "M". Defaults to
// the production-hosted PNG since email clients (Gmail/Outlook) handle PNG
// reliably across desktop/mobile, and absolute URLs are required.
export const LOGO_URL =
  process.env.EMAIL_LOGO_URL || "https://usemoney.ai/icon-square-192.png";
export const UNSUBSCRIBE_SECRET = process.env.EMAIL_UNSUBSCRIBE_SECRET || "";

// MONEY-886: the /api/email/feedback endpoint returns {"error":"Not found"}, so
// the "Was this email useful?" widget is disabled app-wide until it's fixed.
// Flip to true (after MONEY-886) to re-enable.
export const EMAIL_FEEDBACK_WIDGET_ENABLED = false;

// Segment audience IDs (created in Resend dashboard)
export const RESEND_AUDIENCE_FREE_ID =
  process.env.RESEND_AUDIENCE_FREE_ID || "";
export const RESEND_AUDIENCE_PAID_ID =
  process.env.RESEND_AUDIENCE_PAID_ID || "";
export const RESEND_AUDIENCE_DOWNGRADED_ID =
  process.env.RESEND_AUDIENCE_DOWNGRADED_ID || "";
export const RESEND_AUDIENCE_USEMONEY_SECURITY_ID =
  process.env.RESEND_AUDIENCE_USEMONEY_SECURITY_ID || "";
export const RESEND_AUDIENCE_MARKETING_ID =
  process.env.RESEND_AUDIENCE_MARKETING_ID || "";

// Newsletter audience ID — env-aware single var; each Vercel env sets the
// right value:
//   dev / qa : fface17c-b20c-4798-92bc-8ed48f267b45  (usemoney-newsletter-dev)
//   prod     : 169f6d19-ec82-472f-9375-99e4fb0172c8  (usemoney-newsletter)
export const NEWSLETTER_AUDIENCE_ID =
  process.env.RESEND_AUDIENCE_NEWSLETTER_ID || "";

// ---------------------------------------------------------------------------
// Typed segment registry — single source of truth for all Resend audiences.
// Streams 2/3/4/5/6 reference this instead of hardcoding env var names.
// ---------------------------------------------------------------------------

export interface EmailSegment {
  /** Stable identifier used in code (e.g. addToAudience("newsletter", ...)) */
  id: string;
  /** Human-readable label for admin UIs / logs */
  label: string;
  /** Purpose description */
  description: string;
  /** The env var that holds the Resend Audience ID */
  envVar: string;
  /** Resolved audience ID at runtime; undefined when the env var is unset */
  audienceId: string | undefined;
}

export const EMAIL_SEGMENTS: EmailSegment[] = [
  {
    id: "newsletter",
    label: "UseMoney Newsletter",
    description:
      "Marketing newsletter audience — opt-in via signup form or settings",
    envVar: "RESEND_AUDIENCE_NEWSLETTER_ID",
    audienceId: NEWSLETTER_AUDIENCE_ID || undefined,
  },
  {
    id: "marketing",
    label: "UseMoney Marketing",
    description:
      "General marketing audience — not yet provisioned; leave blank until live",
    envVar: "RESEND_AUDIENCE_MARKETING_ID",
    audienceId: RESEND_AUDIENCE_MARKETING_ID || undefined,
  },
];
