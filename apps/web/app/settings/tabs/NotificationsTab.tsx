"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { SetSection, SetToggle } from "./primitives";
import {
  getEmailPreferencesAction,
  updateEmailPreferencesAction,
  getEmailSegmentSubscriptionsAction,
  toggleEmailSegmentSubscriptionAction,
} from "@/lib/actions/email-preferences";
import type { EmailPreferences } from "@usemoney/email";
import { EMAIL_SEGMENTS } from "@usemoney/email";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

interface NotificationsTabProps {
  isDemoMode: boolean;
  email?: string;
}

export default function NotificationsTab({
  isDemoMode,
  email,
}: NotificationsTabProps) {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const [prefs, setPrefs] = useState<EmailPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<keyof EmailPreferences | null>(null);

  // Email segment subscriptions (newsletter + marketing Resend audiences)
  const [segmentSubs, setSegmentSubs] = useState<{
    newsletter: boolean;
    marketing: boolean;
  }>({ newsletter: false, marketing: false });
  const [segmentUpdating, setSegmentUpdating] = useState<
    "newsletter" | "marketing" | null
  >(null);

  // Detect whether the marketing audience is configured
  const marketingSegment = EMAIL_SEGMENTS.find((s) => s.id === "marketing");
  const marketingConfigured = Boolean(marketingSegment?.audienceId);

  const loadPrefs = useCallback(async () => {
    if (isDemoMode) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [prefsResult, segResult] = await Promise.all([
        getEmailPreferencesAction(),
        getEmailSegmentSubscriptionsAction(),
      ]);
      if (prefsResult?.success && prefsResult?.data) {
        setPrefs(prefsResult.data);
      }
      if (segResult?.success) {
        setSegmentSubs(segResult.subscriptions);
      }
    } finally {
      setLoading(false);
    }
  }, [isDemoMode]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  const togglePref = useCallback(
    async (key: keyof EmailPreferences, next: boolean) => {
      if (!prefs || isDemoMode) return;
      const prev = prefs;
      const optimistic = { ...prefs, [key]: next };
      setPrefs(optimistic);
      setUpdating(key);
      try {
        const result = await updateEmailPreferencesAction(optimistic);
        if (!result?.success) {
          setPrefs(prev);
          toast.error("Failed to update preference");
        }
      } catch {
        setPrefs(prev);
        toast.error("Failed to update preference");
      } finally {
        setUpdating(null);
      }
    },
    [prefs, isDemoMode]
  );

  const toggleSegment = useCallback(
    async (segment: "newsletter" | "marketing", next: boolean) => {
      if (isDemoMode) return;
      const prev = segmentSubs;
      setSegmentSubs({ ...segmentSubs, [segment]: next });
      setSegmentUpdating(segment);
      try {
        const result = await toggleEmailSegmentSubscriptionAction(
          segment,
          next
        );
        if (!result.success) {
          setSegmentSubs(prev);
          if (result.error === "marketing-not-configured") {
            toast.error("Marketing emails are not yet active.");
          } else {
            toast.error("Failed to update subscription");
          }
        } else {
          toast.success(
            next ? "Subscribed successfully" : "Unsubscribed successfully"
          );
        }
      } catch {
        setSegmentSubs(prev);
        toast.error("Failed to update subscription");
      } finally {
        setSegmentUpdating(null);
      }
    },
    [isDemoMode, segmentSubs]
  );

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "64px 0",
          color: "var(--ink-3)",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
        }}
      >
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading preferences...
      </div>
    );
  }

  const emailDesc = email ? `Sent to ${email}.` : "Email notifications.";

  return (
    <div className="flex flex-col gap-4">
      {/* Email */}
      <SetSection title="Email" desc={emailDesc}>
        <SetToggle
          label="Broker authentication & sync"
          hint="When a broker token expires, sync completes, or auth fails."
          on={prefs?.brokerNotifications ?? true}
          onChange={(v) => togglePref("brokerNotifications", v)}
          locked={isDemoMode || updating === "brokerNotifications"}
          demo={isDemoMode}
        />
        <SetToggle
          label="Trade alerts"
          hint="Trade import complete and failed emails."
          on={prefs?.tradeAlerts ?? true}
          onChange={(v) => togglePref("tradeAlerts", v)}
          locked={isDemoMode || updating === "tradeAlerts"}
          demo={isDemoMode}
        />
        <SetToggle
          label="Payment & subscription"
          hint="Payment receipts and subscription event emails."
          on={prefs?.paymentNotifications ?? true}
          onChange={(v) => togglePref("paymentNotifications", v)}
          locked={isDemoMode || updating === "paymentNotifications"}
          demo={isDemoMode}
        />
        <SetToggle
          label="AI insights"
          hint="AI query limit reached, weekly digest, big moves in your holdings."
          on={prefs?.aiInsights ?? true}
          onChange={(v) => togglePref("aiInsights", v)}
          locked={isDemoMode || updating === "aiInsights"}
          demo={isDemoMode}
          last
        />
      </SetSection>

      {/* Email subscriptions */}
      <SetSection
        title="Email subscriptions"
        desc="Manage which UseMoney mailing lists you belong to."
      >
        <SetToggle
          label="UseMoney Newsletter"
          hint="Build-in-public updates, monthly"
          on={segmentSubs.newsletter}
          onChange={(v) => toggleSegment("newsletter", v)}
          locked={isDemoMode || segmentUpdating === "newsletter"}
          demo={isDemoMode}
        />
        <SetToggle
          label="Product & marketing"
          hint={
            marketingConfigured
              ? "Launch announcements, occasional product news"
              : "Not yet active"
          }
          on={segmentSubs.marketing}
          onChange={(v) => toggleSegment("marketing", v)}
          locked={
            isDemoMode ||
            !marketingConfigured ||
            segmentUpdating === "marketing"
          }
          demo={isDemoMode}
          last
        />
      </SetSection>

      {/* Marketing */}
      <SetSection title="Marketing">
        <SetToggle
          label="Product updates"
          hint={
            paperTradingEnabled
              ? "New features, paper trading expansions."
              : "New features and product announcements."
          }
          on={prefs?.marketingEmails ?? true}
          onChange={(v) => togglePref("marketingEmails", v)}
          locked={isDemoMode || updating === "marketingEmails"}
          demo={isDemoMode}
        />
        <SetToggle
          label="Tips & education"
          hint="Educational tips and how-tos, about once a fortnight."
          on={prefs?.tipsEducation ?? true}
          onChange={(v) => togglePref("tipsEducation", v)}
          locked={isDemoMode || updating === "tipsEducation"}
          demo={isDemoMode}
        />
        <SetToggle
          label="Partner offers"
          hint="Broker promos, subscription deals."
          on={prefs?.partnerOffers ?? false}
          onChange={(v) => togglePref("partnerOffers", v)}
          locked={isDemoMode || updating === "partnerOffers"}
          demo={isDemoMode}
          last
        />
      </SetSection>
    </div>
  );
}
