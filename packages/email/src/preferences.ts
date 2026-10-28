import { APP_URL } from "./constants";
import { generateUnsubscribeToken } from "./tokens";

export interface EmailPreferences {
  brokerNotifications: boolean;
  tradeAlerts: boolean;
  paymentNotifications: boolean;
  aiInsights: boolean;
  marketingEmails: boolean;
  /** Educational tips & how-to emails (marketing extra) */
  tipsEducation: boolean;
  /** Partner promotions & subscription deals (marketing extra) */
  partnerOffers: boolean;
  /** User consented to anonymized usage analytics (PostHog) */
  usageAnalytics: boolean;
}

export const DEFAULT_EMAIL_PREFERENCES: EmailPreferences = {
  brokerNotifications: true,
  tradeAlerts: true,
  paymentNotifications: true,
  aiInsights: true,
  marketingEmails: true,
  tipsEducation: true,
  partnerOffers: false,
  usageAnalytics: true,
};

export const EMAIL_PREFERENCE_LABELS: Record<
  keyof EmailPreferences,
  { title: string; description: string }
> = {
  brokerNotifications: {
    title: "Broker Notifications",
    description: "Broker connected, disconnected, and sync complete emails",
  },
  tradeAlerts: {
    title: "Trade Alerts",
    description: "Trade import complete and failed emails",
  },
  paymentNotifications: {
    title: "Payment & Subscription",
    description: "Payment and subscription event emails",
  },
  aiInsights: {
    title: "AI Insights",
    description: "AI query limit reached emails",
  },
  marketingEmails: {
    title: "Product Updates & Market Insights",
    description: "Newsletters, feature announcements, and market insights",
  },
  tipsEducation: {
    title: "Tips & Education",
    description: "Educational tips and how-to guides, about once a fortnight",
  },
  partnerOffers: {
    title: "Partner Offers",
    description: "Broker promotions and subscription deals from partners",
  },
  usageAnalytics: {
    title: "Usage Analytics",
    description: "Help improve UseMoney by sharing anonymized usage data",
  },
};

/** Maps template names to preference keys */
export const EMAIL_CATEGORY_MAP: Record<string, keyof EmailPreferences> = {
  "broker-connected": "brokerNotifications",
  "broker-disconnected": "brokerNotifications",
  "sync-complete": "brokerNotifications",
  "trade-import-complete": "tradeAlerts",
  "trade-import-failed": "tradeAlerts",
  "payment-success": "paymentNotifications",
  "payment-failed": "paymentNotifications",
  "subscription-renewed": "paymentNotifications",
  "subscription-cancelled": "paymentNotifications",
  "ai-query-limit": "aiInsights",
};

/** Templates that should always be sent regardless of preferences */
const ALWAYS_SEND = [
  "welcome",
  "account-deleted",
  "newsletter-verify",
  "newsletter-welcome",
];

/**
 * Merge raw JSON from the DB with defaults.
 * Missing keys default to `true` (opt-out model).
 */
export function getEffectivePreferences(raw: unknown): EmailPreferences {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_EMAIL_PREFERENCES };
  }

  const parsed = raw as Record<string, unknown>;
  const prefs = { ...DEFAULT_EMAIL_PREFERENCES };

  for (const key of Object.keys(DEFAULT_EMAIL_PREFERENCES) as Array<
    keyof EmailPreferences
  >) {
    if (typeof parsed[key] === "boolean") {
      prefs[key] = parsed[key] as boolean;
    }
  }

  return prefs;
}

/**
 * Check whether an email should be sent based on user preferences.
 * Returns true for ALWAYS_SEND templates or templates not in the category map.
 */
export function shouldSendEmail(
  prefs: EmailPreferences,
  template: string,
): boolean {
  if (ALWAYS_SEND.includes(template)) {
    return true;
  }

  const category = EMAIL_CATEGORY_MAP[template];
  if (!category) {
    return true; // Unknown templates are sent by default
  }

  return prefs[category];
}

/**
 * Build a one-click unsubscribe URL for a specific email preference category.
 */
export function buildUnsubscribeUrl(
  email: string,
  category: keyof EmailPreferences,
): string {
  const token = generateUnsubscribeToken(email);
  const params = new URLSearchParams({
    email: email.toLowerCase().trim(),
    token,
    category,
  });
  return `${APP_URL}/api/email/preferences/unsubscribe?${params.toString()}`;
}
