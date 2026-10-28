// Client
export { getResendClient } from "./client";

// Send functions
export { sendEmail, sendBatchEmails, sendNewsletter } from "./send";

// Contacts (Resend audience sync)
export {
  addContactToSegment,
  removeContactFromSegment,
  moveContactToSegment,
  listResendContacts,
  addContactToAudience,
  removeContactFromAudience,
  // Newsletter + segment-aware helpers (Stream 1)
  addContactToAudienceByEmail,
  removeContactFromAudienceByEmail,
  addToNewsletterAudience,
  removeFromNewsletterAudience,
  addToAudience,
  removeFromAudience,
} from "./contacts";
export type { Segment, ResendContact } from "./contacts";

// Broadcast (Resend broadcast API)
export {
  sendBroadcast,
  sendBroadcastToSegments,
  clampBroadcastName,
  RESEND_BROADCAST_NAME_MAX,
} from "./broadcast";

// Unsubscribe tokens
export { generateUnsubscribeToken, verifyUnsubscribeToken } from "./tokens";

// Email preferences
export {
  getEffectivePreferences,
  shouldSendEmail,
  buildUnsubscribeUrl,
  DEFAULT_EMAIL_PREFERENCES,
  EMAIL_CATEGORY_MAP,
  EMAIL_PREFERENCE_LABELS,
} from "./preferences";
export type { EmailPreferences } from "./preferences";

// Constants
export {
  EMAIL_FROM,
  EMAIL_REPLY_TO,
  APP_URL,
  RESEND_AUDIENCE_FREE_ID,
  RESEND_AUDIENCE_PAID_ID,
  // Newsletter + segment registry (Stream 1)
  NEWSLETTER_AUDIENCE_ID,
  EMAIL_SEGMENTS,
} from "./constants";
// Re-export with the shorter alias expected by downstream consumers
export { RESEND_AUDIENCE_MARKETING_ID as MARKETING_AUDIENCE_ID } from "./constants";
export type { EmailSegment } from "./constants";

// Theme + one-click unsubscribe header helper (MONEY-878)
export {
  buildListUnsubscribeHeaders,
  SEBI_DISCLAIMER,
  SOCIAL_LINKS,
} from "./theme";

// BlockNote → email HTML converter
export { blocknoteToEmailHtml } from "./blocknote-to-email";

// Analytics (Resend email/broadcast analytics)
export {
  getEmailAnalytics,
  getBroadcastAnalytics,
  listBroadcasts,
} from "./analytics";
export type {
  EmailAnalytics,
  BroadcastAnalytics,
  BroadcastSummary,
} from "./analytics";

// Newsletter sending (shared between content app and workers)
export {
  sendNewsletterBroadcast,
  sendNewsletterToIndividuals,
  routeNewsletterSend,
  splitNewsletterSegments,
} from "./newsletter";
export type { NewsletterSendParams } from "./newsletter";

// Types
export type {
  SendEmailOptions,
  BatchEmailItem,
  SendResult,
  NewsletterSendOptions,
} from "./types";
