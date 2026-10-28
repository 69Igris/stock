import type { ReactElement } from "react";

export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  react: ReactElement;
  /** Template name for logging */
  template: string;
  /**
   * Override the default Reply-To header. Defaults to `EMAIL_REPLY_TO`
   * (founder@usemoney.ai). Useful when sending a team-facing notification
   * where replies should bounce back to the original requester instead of
   * the team inbox.
   */
  replyTo?: string;
  /** Optional metadata for EmailLog */
  metadata?: Record<string, unknown>;
  /**
   * Per-recipient unsubscribe URL. When present, sendEmail attaches RFC 8058
   * `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
   * headers — improves deliverability and is required by Gmail/Yahoo for bulk
   * senders. The unsubscribe endpoint must accept a POST returning a blank 200.
   */
  unsubscribeUrl?: string;
  /** Extra raw email headers, merged with the auto-built List-Unsubscribe set. */
  headers?: Record<string, string>;
  /** Resend tags (analytics / segmentation). */
  tags?: Array<{ name: string; value: string }>;
}

export interface BatchEmailItem {
  to: string;
  subject: string;
  react: ReactElement;
}

export interface SendResult {
  success: boolean;
  resendId?: string;
  error?: string;
}

export interface NewsletterSendOptions {
  subscriberEmails: string[];
  subject: string;
  react: ReactElement;
  /** Template name for logging, defaults to "newsletter-issue" */
  template?: string;
}
