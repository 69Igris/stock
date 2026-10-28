"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import {
  User,
  Crown,
  CreditCard,
  Activity,
  Sliders,
  Bell,
  ShieldCheck,
  Plug,
  MessageSquarePlus,
  ChevronDown,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import Sidebar from "@/components/Sidebar";
import { setCachedPlan } from "@/lib/subscription/plan-cache";
import {
  decidePendingPaymentPoll,
  PENDING_PAYMENT_POLL_INTERVAL_MS,
  type PendingPollResponse,
} from "@/lib/subscription/pending-payment-poll-logic";
import {
  getCachedBillingSummary,
  setCachedBillingSummary,
} from "@/lib/subscription/billing-summary-cache";
import { DemoBanner } from "@/components/DemoBanner";
import { PfPageHead } from "@/components/playful/PfPageHead";
import {
  getSubscriptionAction,
  getPaymentHistoryAction,
  refreshPendingPaymentsAction,
  type SubscriptionData,
} from "@/lib/actions/subscription";
import AccountTab from "./tabs/AccountTab";
import PlansTab from "./tabs/PlansTab";
import BillingTab from "./tabs/BillingTab";
import UsageTab from "./tabs/UsageTab";
import PreferencesTab from "./tabs/PreferencesTab";
import NotificationsTab from "./tabs/NotificationsTab";
import SecurityTab from "./tabs/SecurityTab";
import IntegrationsTab from "./tabs/IntegrationsTab";
import FeedbackTab from "./tabs/FeedbackTab";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

type RouteId =
  | "account"
  | "plans"
  | "billing"
  | "usage"
  | "preferences"
  | "notifications"
  | "security"
  | "integrations"
  | "feedback";

const NAV: Array<{
  id: RouteId;
  icon: LucideIcon;
  label: string;
  breadcrumb: string;
}> = [
  { id: "account", icon: User, label: "Account", breadcrumb: "ACCOUNT" },
  { id: "plans", icon: Crown, label: "Plans", breadcrumb: "PLANS" },
  { id: "billing", icon: CreditCard, label: "Billing", breadcrumb: "BILLING" },
  { id: "usage", icon: Activity, label: "Usage", breadcrumb: "USAGE" },
  {
    id: "preferences",
    icon: Sliders,
    label: "Preferences",
    breadcrumb: "PREFERENCES",
  },
  {
    id: "notifications",
    icon: Bell,
    label: "Notifications",
    breadcrumb: "NOTIFICATIONS",
  },
  {
    id: "security",
    icon: ShieldCheck,
    label: "Security",
    breadcrumb: "SECURITY",
  },
  {
    id: "integrations",
    icon: Plug,
    label: "Integrations",
    breadcrumb: "INTEGRATIONS",
  },
  {
    id: "feedback",
    icon: MessageSquarePlus,
    label: "Feedback",
    breadcrumb: "FEEDBACK",
  },
];

interface PaymentHistoryItem {
  id: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  period: string;
  invoiceUrl: string | null;
  paymentMethod: string | null;
  paymentMethodType: string | null;
  cardLastFour: string | null;
  cardNetwork: string | null;
}

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useUser();

  const [route, setRoute] = useState<RouteId>("account");
  const isDemoMode = useIsDemoMode({ user });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionData | null>(
    null
  );
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryItem[]>(
    []
  );
  const [isLoadingPayments, setIsLoadingPayments] = useState(true);
  const handledPaymentRef = useRef(false);
  const pendingRefreshRanRef = useRef(false);
  // Hand-off from the URL-detection effect to the poll effect. Keeping the poll
  // in its OWN effect (keyed on this stable id) is what makes it survive the
  // `router.replace` that strips the ?payment= params: that replace changes
  // `searchParams` and re-runs the detection effect, but NOT the poll effect.
  const [pendingPaymentId, setPendingPaymentId] = useState<string | null>(null);

  // Read ?tab= from URL on mount + when it changes
  useEffect(() => {
    const tab = searchParams.get("tab");
    const valid = NAV.find((n) => n.id === tab);
    if (valid) setRoute(valid.id);
  }, [searchParams]);

  // Initial loads (skip when in demo mode — the hook tracks demo state).
  useEffect(() => {
    if (isDemoMode) {
      setIsLoadingPayments(false);
      return;
    }
    // Instant paint (MONEY-764): hydrate the billing hero from the persisted
    // summary the moment the Clerk user resolves, so the plan card doesn't
    // sit on FREE/"—" for the full getSubscriptionAction round trip. The
    // fetch below always runs and overwrites both state and cache; a userId
    // mismatch in storage reads as a miss (no cross-account paints).
    if (user?.id) {
      setSubscription(
        (prev) =>
          prev ?? getCachedBillingSummary<SubscriptionData>(user.id) ?? prev
      );
    }
    loadSubscription();
    loadPaymentHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isDemoMode]);

  const userId = user?.id;
  const loadSubscription = useCallback(async () => {
    try {
      const result = await getSubscriptionAction();
      if (result?.success && result?.data) {
        setSubscription(result.data);
        // Keep the client plan-cache (sidebar tier tag) in sync with the
        // fresh DB plan. This runs on the post-payment redirect too, so an
        // upgrade reflects in the sidebar live — MONEY-650 billing fix.
        setCachedPlan(result.data.planId);
        // Persist for next visit's instant paint (settings billing hero).
        if (userId) setCachedBillingSummary(userId, result.data);
      }
    } catch {
      // Silent fail
    }
  }, [userId]);

  const loadPaymentHistory = useCallback(async () => {
    setIsLoadingPayments(true);
    try {
      // Paint invoices immediately — don't gate the billing tab on the
      // per-PENDING-payment Dodo poll (MONEY-764).
      const result = await getPaymentHistoryAction();
      const history = result?.success && result?.data ? result.data : null;
      if (history) {
        setPaymentHistory(history);
      }
      // Only poll Dodo when something is actually pending, and off the paint
      // path: once it settles, re-fetch history and the subscription so a
      // just-completed payment's plan/credits reflect without blocking render.
      // Guards (the invoice list visibly "kept refreshing" without them):
      //  - once per mount — re-running effects must not re-poll + repaint
      //  - 48h age gate — abandoned checkouts stay PENDING forever and must
      //    never re-trigger the poll cycle on every settings visit
      const RECENT_PENDING_MS = 48 * 60 * 60 * 1000;
      const hasRecentPending = history?.some(
        (p) =>
          p.status === "PENDING" &&
          Date.now() - new Date(p.createdAt).getTime() < RECENT_PENDING_MS
      );
      if (hasRecentPending && !pendingRefreshRanRef.current) {
        pendingRefreshRanRef.current = true;
        void (async () => {
          try {
            await refreshPendingPaymentsAction();
            const refreshed = await getPaymentHistoryAction();
            if (refreshed?.success && refreshed?.data) {
              setPaymentHistory(refreshed.data);
            }
            await loadSubscription();
          } catch {
            // Silent fail — the next visit retries.
          }
        })();
      }
    } catch {
      // Silent fail
    } finally {
      setIsLoadingPayments(false);
    }
  }, [loadSubscription]);

  // Handle payment-completion / pending toast - preserved from old client
  useEffect(() => {
    if (handledPaymentRef.current) return;
    const success = searchParams.get("success");
    const paymentStatus = searchParams.get("payment");
    const paymentId = searchParams.get("paymentId");

    if (success === "payment_complete") {
      handledPaymentRef.current = true;
      toast.success("Payment successful! Your plan has been upgraded.");
      router.replace("/settings?tab=billing");
      loadSubscription();
      loadPaymentHistory();
      return;
    }

    if (paymentStatus === "pending" && paymentId) {
      handledPaymentRef.current = true;
      // Hand the poll off to its OWN effect (keyed on pendingPaymentId), THEN
      // strip the ?payment= params. The replace re-runs THIS detection effect
      // (no-op via handledPaymentRef) but NOT the poll effect below — so the
      // poll runs to completion instead of tearing itself down via its own URL
      // change (MONEY-1074).
      setPendingPaymentId(paymentId);
      router.replace("/settings?tab=billing");
    }
  }, [searchParams, router, loadSubscription, loadPaymentHistory]);

  // Bounded pending-payment poll (MONEY-1074). Keyed on the stable
  // pendingPaymentId so the detection effect's router.replace can't cancel it;
  // the cleanup cancels the poll + clears its timer on real unmount (no leaked
  // timer), and dismisses a still-loading toast if we leave mid-verification.
  // The server-side refresh now APPLIES the plan grant on COMPLETED, so a
  // success here reflects the real upgraded plan. Provably terminates via
  // decidePendingPaymentPoll's attempt cap.
  useEffect(() => {
    if (!pendingPaymentId) return;
    const paymentId = pendingPaymentId;
    const toastId = toast.loading("Verifying your payment...");
    let cancelled = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let consecutiveFailures = 0;

    const step = async () => {
      if (cancelled) return;
      attempt += 1;
      let res: PendingPollResponse;
      let paymentErrorMessage: string | null | undefined;
      try {
        await refreshPendingPaymentsAction();
        const result = await getPaymentHistoryAction();
        const payment = result?.data?.find((p) => p.id === paymentId);
        paymentErrorMessage = payment?.errorMessage;
        res = { ok: !!result?.success, status: payment?.status ?? null };
      } catch {
        res = { ok: false };
      }
      if (cancelled) return;

      const decision = decidePendingPaymentPoll(res, {
        attempt,
        consecutiveFailures,
      });
      consecutiveFailures = decision.consecutiveFailures;
      if (decision.action !== "continue") settled = true;

      switch (decision.action) {
        case "stop-completed":
          toast.success("Payment successful! Your plan has been upgraded.", {
            id: toastId,
          });
          loadSubscription();
          loadPaymentHistory();
          return;
        case "stop-failed":
          toast.error(
            paymentErrorMessage || "Payment failed. Please try again.",
            { id: toastId }
          );
          loadPaymentHistory();
          return;
        case "stop-exhausted":
          toast.dismiss(toastId);
          toast.info(
            "Payment is still processing. Check billing tab for updates.",
            { duration: 8000 }
          );
          return;
        case "stop-error":
          toast.dismiss(toastId);
          toast.info(
            "Unable to verify payment. Check billing tab for updates.",
            { duration: 8000 }
          );
          return;
        case "continue":
          timer = setTimeout(step, PENDING_PAYMENT_POLL_INTERVAL_MS);
          return;
      }
    };

    void step();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      // Clear a still-loading toast if we unmount mid-verification (also keeps
      // React StrictMode's dev double-invoke from orphaning the first toast).
      if (!settled) toast.dismiss(toastId);
    };
  }, [pendingPaymentId, loadSubscription, loadPaymentHistory]);

  const navigate = useCallback(
    (id: RouteId) => {
      setRoute(id);
      router.replace(`/settings?tab=${id}`);
    },
    [router]
  );

  const isPro =
    subscription?.planId === "PRO" ||
    subscription?.planId === "PREMIUM" ||
    subscription?.planId === "ULTIMATE";
  const planLabel =
    subscription?.planId === "PRO"
      ? // MONEY-866: one-time "lifetime" PRO is deprecated — show the real cycle;
        // "Lifetime" only for legacy grandfathered PROs (no billing cycle).
        subscription.billingPeriod === "annual"
        ? "PRO · Annual"
        : subscription.billingPeriod === "monthly"
          ? "PRO · Monthly"
          : "PRO · Lifetime"
      : subscription?.planId
        ? subscription.planId
        : "FREE";

  const activeNav = NAV.find((n) => n.id === route) || NAV[0];

  const renderBody = () => {
    switch (route) {
      case "account":
        return <AccountTab isDemoMode={isDemoMode} />;
      case "plans":
        return <PlansTab subscription={subscription} isDemoMode={isDemoMode} />;
      case "billing":
        return (
          <BillingTab
            subscription={subscription}
            paymentHistory={paymentHistory}
            isDemoMode={isDemoMode}
            isLoadingPayments={isLoadingPayments}
          />
        );
      case "usage":
        return <UsageTab subscription={subscription} />;
      case "preferences":
        return <PreferencesTab isDemoMode={isDemoMode} />;
      case "notifications":
        return (
          <NotificationsTab
            isDemoMode={isDemoMode}
            email={
              user?.primaryEmailAddress?.emailAddress ||
              user?.emailAddresses?.[0]?.emailAddress
            }
          />
        );
      case "security":
        return <SecurityTab isDemoMode={isDemoMode} />;
      case "integrations":
        return <IntegrationsTab isDemoMode={isDemoMode} isPro={isPro} />;
      case "feedback":
        return <FeedbackTab />;
    }
  };

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />

      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-6 pb-24 pt-6 max-w-[1180px] mx-auto">
          {isDemoMode && <DemoBanner />}

          {/* Header — playful eyebrow + serif headline + PRO pill */}
          <PfPageHead
            eyebrow={`SETTINGS · ${activeNav.breadcrumb}`}
            title={
              <>
                Settings, <span className="ser">your</span>{" "}
                <span className="hl">way.</span>
              </>
            }
            sub="Everything personal — sign-in, plan, and how we reach you."
            right={
              <span className="pf-pill violet">
                <Crown className="h-3 w-3" />
                {planLabel}
              </span>
            }
          />

          {/* Mobile section picker — visible below 1024px */}
          <div className="lg:hidden relative mb-4">
            <button
              type="button"
              onClick={() => setMobileNavOpen((v) => !v)}
              aria-expanded={mobileNavOpen}
              aria-haspopup="dialog"
              className="pf-bf"
              style={{
                width: "100%",
                justifyContent: "space-between",
                background: mobileNavOpen
                  ? "var(--emerald-bg)"
                  : "var(--paper)",
                borderColor: mobileNavOpen ? "var(--emerald)" : "var(--ink)",
                color: mobileNavOpen ? "var(--emerald-text)" : "var(--ink)",
              }}
            >
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <activeNav.icon className="h-4 w-4" />
                {activeNav.label}
              </span>
              <ChevronDown
                className="h-4 w-4 transition-transform"
                style={{
                  color: "var(--ink-3)",
                  transform: mobileNavOpen ? "rotate(180deg)" : "none",
                }}
              />
            </button>

            {mobileNavOpen && (
              <>
                <div
                  onClick={() => setMobileNavOpen(false)}
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 95,
                    background: "rgba(0,0,0,0.25)",
                  }}
                />
                <div
                  role="dialog"
                  aria-label="Settings sections"
                  className="pf-card"
                  style={{
                    position: "absolute",
                    top: "calc(100% + 6px)",
                    left: 0,
                    right: 0,
                    zIndex: 96,
                    padding: 8,
                    maxHeight: "calc(100vh - 220px)",
                    overflowY: "auto",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "8px 10px 6px",
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 1.8,
                        color: "var(--ink-3)",
                      }}
                    >
                      SECTIONS
                    </span>
                    <button
                      type="button"
                      onClick={() => setMobileNavOpen(false)}
                      aria-label="Close"
                      className="pf-tb-icon-btn"
                      style={{ width: 26, height: 26 }}
                    >
                      <X style={{ width: 13, height: 13 }} />
                    </button>
                  </div>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(2, 1fr)",
                      gap: 6,
                    }}
                  >
                    {NAV.map((n) => {
                      const Icon = n.icon;
                      const active = route === n.id;
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            navigate(n.id);
                            setMobileNavOpen(false);
                          }}
                          className={`set-nav-it${active ? " active" : ""}`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            padding: "10px 12px",
                            borderRadius: 8,
                            border: 0,
                            fontSize: 13,
                            fontWeight: 600,
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <Icon style={{ width: 14, height: 14 }} />
                          <span>{n.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-7 items-start">
            {/* Left rail — sticky playful nav card */}
            <aside className="hidden lg:block sticky top-[102px]">
              <div
                className="pf-card"
                style={{
                  padding: 14,
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 1.8,
                    color: "var(--ink-3)",
                    padding: "6px 8px 8px",
                  }}
                >
                  SETTINGS
                </div>
                {NAV.map((n) => {
                  const active = route === n.id;
                  const Icon = n.icon;
                  return (
                    <button
                      key={n.id}
                      onClick={() => navigate(n.id)}
                      className={`set-nav-it${active ? " active" : ""}`}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 10px",
                        textAlign: "left",
                        border: 0,
                        borderRadius: 8,
                        fontSize: 13.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                      {n.label}
                    </button>
                  );
                })}
              </div>

              {/* Support sticker */}
              <div className="pf-sticker" style={{ margin: "16px 0 0" }}>
                <strong>Need a hand?</strong> Reach us at{" "}
                <a
                  href="mailto:help@usemoney.ai"
                  style={{ color: "#1d1d1b", textDecoration: "underline" }}
                >
                  help@usemoney.ai
                </a>{" "}
                — usually replies in 4h.
              </div>
            </aside>

            {/* Body */}
            <div className="min-w-0">{renderBody()}</div>
          </div>
        </div>

        <style>{`
            .set-nav-it { color: var(--ink-2); background: transparent; }
            .set-nav-it:hover { background: var(--rule-softer); color: var(--ink); }
            .set-nav-it.active,
            .set-nav-it.active:hover { background: var(--ink); color: var(--paper); }
            .set-row:hover { background: var(--rule-softer); }
          `}</style>
      </main>
    </div>
  );
}
