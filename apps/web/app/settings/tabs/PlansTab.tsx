"use client";

import { useState } from "react";
import {
  Check,
  Minus,
  ArrowUpRight,
  ArrowDown,
  Brain,
  Loader2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { SetSection } from "./primitives";
import {
  createCheckoutAction,
  previewPlanChangeAction,
  scheduleCancelAction,
  scheduleDowngradeAction,
  unscheduleChangeAction,
  type SubscriptionData,
} from "@/lib/actions/subscription";
import { validateCouponAction } from "@/lib/actions/coupon";
import { getStoredPromo, clearStoredPromo } from "@/lib/promo";
import { CREDIT_PACKS } from "@usemoney/core/subscription";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import PlanChangeConfirmDialog, {
  type PlanChangePreviewData,
} from "@/components/pricing/PlanChangeConfirmDialog";
// MONEY-438 / Pricing v2: shared Monthly/Yearly toggle so cycle state
// round-trips with Landing + /pricing via ?cycle= URL param.
import BillingCycleToggle from "@/components/pricing/BillingCycleToggle";
import { useBillingCycle } from "@/lib/pricing/useBillingCycle";
import {
  formatSavingsAbsolute,
  formatSavingsPct,
  formatLaunchDiscount,
} from "@/lib/pricing/savings-format";

interface PlansTabProps {
  subscription: SubscriptionData | null;
  isDemoMode: boolean;
}

interface Plan {
  id: string;
  name: string;
  /** Monthly price in INR. null = no monthly cycle (e.g. FREE). */
  monthlyPrice: number | null;
  /** Annual price in INR. null = no annual cycle (e.g. FREE). */
  annualPrice: number | null;
  /** Original monthly price for the strikethrough launch-offer anchor. */
  originalMonthlyPrice?: number | null;
  /** Original annual price for strikethrough. */
  originalAnnualPrice?: number | null;
  /** Copy under the price for the FREE tier. */
  freeCopy?: string;
  blurb: string;
  accent: string;
  features: Array<[string, boolean]>;
  // Static CTA fields are retained as legacy fallbacks for the FREE
  // card; the paid cards compute their CTA from the user's tier + the
  // toggle cycle so the badge and button stay in sync (MONEY-481).
  ctaTone: "current" | "upgrade" | "danger";
  cta: string;
}

// MONEY-438: numbers mirror Landing PricingPreview + plans.ts. When you
// change pricing, update all three. The plans.ts <-> /pricing drift
// is tracked separately under MONEY-477.
const PLANS: Plan[] = [
  {
    id: "FREE",
    name: "Free",
    monthlyPrice: null,
    annualPrice: null,
    freeCopy: "forever",
    blurb: "Kick the tires. 1 broker, capped AI.",
    accent: "var(--text-muted)",
    features: [
      ["1 broker connection", true],
      ["Holdings + sectors", true],
      ["StockSage · 5 credits / mo", true],
      ["Quick analysis only", true],
      ["Paper trading · ₹1 L virtual", true],
      ["1 portfolio roast / quarter", true],
      ["Document vault · 5 docs", true],
      ["MF analysis & comparison", false],
      ["Price alerts · email only", true],
      ["API access", false],
    ],
    cta: "Downgrade",
    ctaTone: "danger",
  },
  {
    id: "PRO",
    name: "Pro",
    monthlyPrice: 249,
    annualPrice: 1999,
    originalMonthlyPrice: 499,
    originalAnnualPrice: 4999,
    blurb: "Everything you actually need.",
    accent: "#34d399",
    features: [
      ["Unlimited brokers", true],
      ["Holdings + sectors + tax view", true],
      ["StockSage · 50 credits / mo", true],
      ["Deep Dive + Comprehensive analysis", true],
      ["Paper trading · ₹10 L virtual", true],
      ["Unlimited roasts", true],
      ["Document vault · 100 docs", true],
      ["MF analysis & comparison", true],
      ["Multi-channel alerts", true],
      ["Credit pack purchases", true],
    ],
    // CTA + tone are derived per render from currentPlanId (see
    // dynamicTone / dynamicCta below) so this static field is the
    // 'Upgrade to Pro' default for FREE users. It's overridden when
    // currentPlanId === 'PRO'.
    cta: "Upgrade to Pro",
    ctaTone: "upgrade",
  },
  {
    id: "PREMIUM",
    name: "Premium",
    monthlyPrice: 1499,
    annualPrice: 14999,
    originalMonthlyPrice: 2999,
    originalAnnualPrice: 30000,
    blurb: "Power user. Advanced research, more credits.",
    accent: "#a78bfa",
    features: [
      ["Everything in Pro", true],
      ["StockSage · 200 credits / mo", true],
      ["Personalized learning modules", true],
      ["Portfolio AI analysis", true],
      ["Paper trading + AI analysis", true],
      ["Build strategies with AI", true],
      ["Document vault · unlimited", true],
      ["Priority StockSage queue", true],
      ["Tax-loss harvest planner", true],
      ["Priority support", true],
    ],
    cta: "Upgrade to Premium",
    ctaTone: "upgrade",
  },
];

// MONEY-481: keep checkout-failure toasts generic. The server action
// already returns sanitized strings, but the SDK + lower layers can
// occasionally bubble up raw provider messages (HTTP codes, stack
// traces, tier names). Allowlist only the short, user-friendly strings
// we explicitly write ourselves; everything else collapses to a
// neutral "try again" message.
const ALLOWED_CHECKOUT_ERRORS = new Set<string>([
  "Please sign in to upgrade your plan",
  "Invalid plan",
  "This plan is not yet available. Please try again later.",
  "Authentication required",
  "Unable to create checkout session. Please try again in a few moments.",
  "Failed to create checkout session. Please try again.",
]);
function sanitizeCheckoutError(raw: string | undefined): string {
  if (raw && ALLOWED_CHECKOUT_ERRORS.has(raw)) return raw;
  return "We could not start checkout. Please try again in a moment.";
}

// MONEY-394 L - plan-tier ordering used to derive CTA tone per card
// (current vs upgrade vs downgrade) instead of relying on the static
// ctaTone field, which was hardcoded to 'current' on the Pro card and
// caused both Free + Pro to show 'Current plan' for FREE users.
const PLAN_TIER: Record<string, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
  ULTIMATE: 3,
};

export default function PlansTab({ subscription, isDemoMode }: PlansTabProps) {
  const router = useRouter();
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  // MONEY-438: shared cycle state via useBillingCycle, persisted via
  // ?cycle= URL param so the toggle agrees with Landing + /pricing.
  // Local `billing` alias preserved so the existing rendering branches
  // below don't need rename surgery.
  const [billing, setBilling] = useBillingCycle({ defaultCycle: "annual" });
  // Best savings % across paid tiers, used by the toggle "Save X%" badge.
  // Computed from the same monthly/annual numbers the cards render so the
  // badge can never disagree with the prices below it.
  const headlineSavingsPct = pickHeadlineSavings(PLANS);
  // MONEY-481: read the cycle of the user's ACTUAL subscription (not the
  // toggle position) so we can tell apart "Current plan" (matching cycle)
  // from "Switch to {cycle}" (same tier, different cycle).
  const actualCycle: "monthly" | "annual" =
    subscription?.billingPeriod === "annual" ? "annual" : "monthly";
  const [processingPack, setProcessingPack] = useState<number | null>(null);
  // MONEY-481: loading state for the per-card upgrade/switch button so
  // we can disable the card while Dodo Checkout is being prepared.
  const [processingPlanId, setProcessingPlanId] = useState<string | null>(null);
  // MONEY-482: confirm-dialog state. Opened by requestPlanChange after
  // previewPlanChangeAction returns; confirm fires the right action
  // (createCheckout for immediate paths, scheduleCancel/Downgrade for
  // deferred paths). The pending target is preserved so confirmation
  // does not need to re-query.
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogPreview, setDialogPreview] =
    useState<PlanChangePreviewData | null>(null);
  const [dialogTarget, setDialogTarget] = useState<{
    planId: "PRO" | "PREMIUM" | "FREE";
    cycle: "monthly" | "annual" | null;
    fromLabel: string;
    toLabel: string;
  } | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);

  // MONEY-865: coupon-at-upgrade state. Applied via validateCouponAction in the
  // confirm dialog; the code rides into createCheckoutAction, which re-validates
  // server-side and may skip the Dodo page entirely (fully-covered).
  const [couponInput, setCouponInput] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState<{
    code: string;
    discountType: "percent" | "flat";
    discountPercent: number;
    discountAmount?: number;
    couponName?: string;
  } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);

  const resetCoupon = () => {
    setCouponInput("");
    setAppliedCoupon(null);
    setCouponError(null);
    setCouponBusy(false);
  };

  const handleApplyCoupon = async () => {
    const code = couponInput.trim();
    if (!code) return;
    setCouponBusy(true);
    setCouponError(null);
    try {
      // Pass the plan AND billing cycle being purchased so a plan- or
      // cycle-scoped coupon is validated against them (the same check runs
      // server-side at checkout). MONEY-865: without the cycle the gate saw a
      // null period and rejected every cycle-restricted coupon ("not valid for
      // the selected billing cycle") even on a matching cycle.
      const res = await validateCouponAction(
        code,
        dialogTarget?.planId,
        dialogTarget?.cycle ?? undefined
      );
      if (!res.valid) {
        setAppliedCoupon(null);
        setCouponError(res.error ?? "Invalid coupon code");
        return;
      }
      setAppliedCoupon({
        code: code.toUpperCase(),
        discountType: res.discountType ?? "percent",
        discountPercent: res.discountPercent ?? 0,
        discountAmount: res.discountAmount,
        couponName: res.couponName,
      });
    } catch {
      setCouponError("Couldn't validate coupon. Try again.");
    } finally {
      setCouponBusy(false);
    }
  };
  const currentPlanId = subscription?.planId || "FREE";

  // Credit usage - same data the /pricing page + UsageTab read.
  const creditsLimit = subscription?.creditsLimit ?? 0;
  const creditsUsed = subscription?.creditsUsed ?? 0;
  const packLimit = subscription?.packCreditsLimit ?? 0;
  const packUsed = subscription?.packCreditsUsed ?? 0;
  const planRemaining = Math.max(0, creditsLimit - creditsUsed);
  const packRemaining = Math.max(0, packLimit - packUsed);
  const totalRemaining = planRemaining + packRemaining;
  const planPct =
    creditsLimit > 0 ? Math.min(100, (creditsUsed / creditsLimit) * 100) : 0;
  const packPct =
    packLimit > 0 ? Math.min(100, (packUsed / packLimit) * 100) : 0;

  // MONEY-481: direct-checkout for plan changes. Replaces the previous
  // `router.push("/pricing")` detour — signed-in users with an active
  // subscription should NOT be sent back to the marketing page just to
  // click another button. We invoke Dodo Checkout in-place exactly like
  // handleBuyPack does for credit packs.
  //
  // The `targetCycle` argument respects the user's chosen cycle on the
  // page (monthly vs annual toggle). For FREE downgrades, the server
  // action returns success without a checkoutUrl (it updates the plan
  // directly); the toast confirms and we refresh.
  // MONEY-482: open the confirm dialog with a preview of what will
  // happen. This is the entry point every paid-card button uses now —
  // never call handlePlanChange / scheduleCancelAction directly from
  // the click handler.
  const labelForCycle = (
    planId: "PRO" | "PREMIUM" | "FREE",
    c: "monthly" | "annual" | null
  ): string => {
    if (planId === "FREE") return "Free";
    return `${planId === "PRO" ? "PRO" : "Premium"} ${c === "annual" ? "Annual" : "Monthly"}`;
  };

  const requestPlanChange = async (
    planId: "PRO" | "PREMIUM" | "FREE",
    targetCycle: "monthly" | "annual" | null
  ) => {
    if (isDemoMode) {
      toast.error("Sign up to change plans.");
      return;
    }
    const preview = await previewPlanChangeAction(planId, targetCycle);
    if (!preview.success || !preview.kind) {
      toast.error(sanitizeCheckoutError(preview.error));
      return;
    }
    if (preview.kind === "noop") {
      // MONEY-1074: don't silently swallow a same-plan click — tell the user why
      // nothing happened.
      toast.info("You're already on this plan.");
      return;
    }
    setDialogPreview({
      kind: preview.kind,
      daysRemaining: preview.daysRemaining,
      bonusDays: preview.bonusDays,
      newTermDays: preview.newTermDays,
      effectiveAt: preview.effectiveAt,
      willChargeToday: preview.willChargeToday,
    });
    setDialogTarget({
      planId,
      cycle: targetCycle,
      fromLabel: labelForCycle(
        currentPlanId as "PRO" | "PREMIUM" | "FREE",
        (subscription?.billingPeriod ?? null) as "monthly" | "annual" | null
      ),
      toLabel: labelForCycle(planId, targetCycle),
    });
    resetCoupon();
    // MONEY-385: pre-fill from a captured ?promo= code (marketing CTA). The
    // user still clicks Apply; the code is re-validated server-side at checkout.
    const storedPromo = getStoredPromo();
    if (storedPromo) setCouponInput(storedPromo);
    setDialogOpen(true);
  };

  const confirmPlanChange = async () => {
    if (!dialogTarget || !dialogPreview) return;
    setDialogBusy(true);
    try {
      const { planId, cycle } = dialogTarget;
      // Dispatch by transition kind. Immediate paths go through
      // createCheckoutAction (Dodo overlay); scheduled paths stamp the
      // schedule fields server-side and the cron flips at term end.
      if (dialogPreview.kind === "cancel") {
        const r = await scheduleCancelAction();
        if (!r.success) {
          toast.error(sanitizeCheckoutError(r.error));
          return;
        }
        toast.success("Cancellation scheduled. You keep access until expiry.");
        setDialogOpen(false);
        router.refresh();
        return;
      }
      if (
        dialogPreview.kind === "tier_downgrade" ||
        dialogPreview.kind === "cycle_downgrade"
      ) {
        if (planId === "FREE" || !cycle) {
          toast.error("Invalid downgrade target");
          return;
        }
        const r = await scheduleDowngradeAction(planId, cycle);
        if (!r.success) {
          toast.error(sanitizeCheckoutError(r.error));
          return;
        }
        toast.success(
          "Downgrade scheduled. You keep your current plan until expiry."
        );
        setDialogOpen(false);
        router.refresh();
        return;
      }
      // Immediate: first_purchase, cycle_append, tier_upgrade.
      const res = await handlePlanChange(
        planId,
        cycle ?? undefined,
        appliedCoupon?.code
      );
      // MONEY-865: a checkout failure WITH a coupon applied is surfaced inline
      // in the coupon area (it's almost always the coupon: already used /
      // expired / wrong plan-cycle). Drop the now-stale applied coupon, show the
      // exact server reason, and keep the dialog open so the user can fix it.
      // Non-coupon failures already toasted inside handlePlanChange.
      if (!res.ok && appliedCoupon) {
        setAppliedCoupon(null);
        setCouponInput(appliedCoupon.code);
        setCouponError(
          res.error ?? "This coupon can no longer be applied. Please try again."
        );
        return;
      }
      if (res.ok) setDialogOpen(false);
    } finally {
      setDialogBusy(false);
    }
  };

  const handleUndoScheduledChange = async () => {
    const r = await unscheduleChangeAction();
    if (!r.success) {
      toast.error(sanitizeCheckoutError(r.error));
      return;
    }
    toast.success("Scheduled change cancelled.");
    router.refresh();
  };

  const handlePlanChange = async (
    planId: "PRO" | "PREMIUM" | "FREE",
    targetCycle: "monthly" | "annual" | undefined,
    discountCode?: string
  ): Promise<{ ok: boolean; error?: string }> => {
    if (isDemoMode) {
      toast.error("Sign up to change plans.");
      return { ok: false };
    }
    setProcessingPlanId(planId);
    try {
      const result = await createCheckoutAction(
        planId,
        targetCycle,
        discountCode
      );
      if (!result?.success) {
        // MONEY-865: when a coupon was applied, the failure is most often
        // coupon-specific (already used / expired / wrong plan-cycle, or the
        // downgrade guard). Hand the precise server string back to the caller
        // so confirmPlanChange can show it inline in the coupon area and keep
        // the dialog open, instead of swallowing it behind a generic toast.
        // For non-coupon failures the caller falls back to the sanitized toast.
        if (!discountCode) {
          // MONEY-481: surface a generic toast. The server-action error
          // strings are already sanitized (see subscription.ts), but we
          // narrow further here so a raw Dodo SDK error string can never
          // leak into the UI by accident.
          toast.error(sanitizeCheckoutError(result?.error));
        }
        return { ok: false, error: result?.error };
      }
      if (result.checkoutUrl) {
        const dodo = (
          window as unknown as {
            DodoPayments?: {
              Checkout?: { open: (a: { checkoutUrl: string }) => void };
            };
          }
        ).DodoPayments;
        if (dodo?.Checkout) {
          dodo.Checkout.open({ checkoutUrl: result.checkoutUrl });
        } else {
          window.location.href = result.checkoutUrl;
        }
      } else {
        // No checkoutUrl: FREE downgrade OR a fully-covered coupon grant — the
        // server already swapped the plan. Clear any used promo so it doesn't
        // keep pre-filling the next time.
        clearStoredPromo();
        toast.success("Plan updated.");
        router.refresh();
      }
      return { ok: true };
    } catch {
      toast.error("Something went wrong. Please try again.");
      return { ok: false };
    } finally {
      setProcessingPlanId(null);
    }
  };

  const handleBuyPack = async (credits: number) => {
    if (isDemoMode) {
      toast.error("Sign up to purchase credit packs.");
      return;
    }
    if (currentPlanId === "FREE") {
      toast.error("Upgrade to PRO or Premium to purchase credit packs.");
      return;
    }
    setProcessingPack(credits);
    try {
      const result = await createCheckoutAction(`CREDIT_PACK_${credits}`);
      if (result?.success && result.checkoutUrl) {
        const checkoutUrl = result.checkoutUrl;
        const dodo = (
          window as unknown as {
            DodoPayments?: {
              Checkout?: { open: (a: { checkoutUrl: string }) => void };
            };
          }
        ).DodoPayments;
        if (dodo?.Checkout) {
          dodo.Checkout.open({ checkoutUrl });
        } else {
          window.location.href = checkoutUrl;
        }
      } else {
        toast.error(sanitizeCheckoutError(result?.error));
      }
    } finally {
      setProcessingPack(null);
    }
  };

  return (
    <div className="flex flex-col gap-[18px]">
      {/* Header */}
      <div>
        <div
          style={{
            fontSize: 24,
            fontWeight: 800,
            letterSpacing: -0.6,
            color: "var(--ink)",
          }}
        >
          Plans &amp; <span className="ser">pricing.</span>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--ink-3)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          You&apos;re on{" "}
          <span style={{ color: "var(--emerald-text)", fontWeight: 700 }}>
            {currentPlanId} · active
          </span>
          . Switch any time — your current term is honored until expiry.
        </div>
      </div>

      {/* MONEY-482: scheduled-change banner. When the user has queued a
          downgrade or cancel, surface it at the top with an Undo button
          so they can reverse before the effective date. */}
      {subscription?.scheduledPlanId && (
        <div
          className="pf-card flat"
          style={{
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: 13,
            background: "rgba(245,158,11,0.1)",
            borderColor: "#b45309",
          }}
        >
          <div className="flex-1 leading-snug">
            <span style={{ fontWeight: 700, color: "var(--ink)" }}>
              {subscription.scheduledPlanId === "FREE"
                ? subscription.scheduledChangeUndoable
                  ? "Your subscription will end"
                  : "Your coupon access ends"
                : `Your plan will switch to ${subscription.scheduledPlanId}${
                    subscription.scheduledBillingPeriod
                      ? ` ${subscription.scheduledBillingPeriod}`
                      : ""
                  }`}
            </span>
            {subscription.scheduledEffectiveAt && (
              <>
                {" on "}
                <span className="mono" style={{ color: "var(--ink)" }}>
                  {new Date(
                    subscription.scheduledEffectiveAt
                  ).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </>
            )}
            {subscription.scheduledChangeUndoable
              ? ". No refund — your current term is honored until then."
              : ". You'll move to Free then."}
          </div>
          {subscription.scheduledChangeUndoable && (
            <button
              type="button"
              onClick={handleUndoScheduledChange}
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: "var(--ink)",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}

      {/* MONEY-482: confirm dialog mounted at the page root so it can
          overlay any card click. Preview + target state drive the copy. */}
      <PlanChangeConfirmDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) {
            setDialogBusy(false);
            resetCoupon();
          }
        }}
        fromLabel={dialogTarget?.fromLabel ?? ""}
        toLabel={dialogTarget?.toLabel ?? ""}
        preview={dialogPreview}
        busy={dialogBusy}
        onConfirm={confirmPlanChange}
        couponSlot={
          appliedCoupon ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                border: "1.5px solid var(--ink)",
                borderRadius: 10,
                padding: "8px 12px",
                background: "var(--paper-2)",
              }}
            >
              <div style={{ fontSize: 13, color: "var(--ink-2)" }}>
                <strong className="mono">{appliedCoupon.code}</strong> applied —{" "}
                {appliedCoupon.discountType === "flat"
                  ? `₹${appliedCoupon.discountAmount ?? 0} off`
                  : appliedCoupon.discountPercent >= 100
                    ? "100% off · no payment needed"
                    : `${appliedCoupon.discountPercent}% off`}
              </div>
              <button
                type="button"
                onClick={resetCoupon}
                className="pf-bf sm"
                style={{ flexShrink: 0 }}
              >
                Remove
              </button>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={couponInput}
                  onChange={(e) => {
                    setCouponInput(e.target.value.toUpperCase());
                    setCouponError(null);
                  }}
                  placeholder="Coupon code"
                  className="mono"
                  style={{
                    flex: 1,
                    padding: "8px 12px",
                    border: "1.5px solid var(--ink)",
                    borderRadius: 10,
                    background: "var(--paper)",
                    color: "var(--ink)",
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  onClick={handleApplyCoupon}
                  disabled={couponBusy || !couponInput.trim()}
                  className="pf-bs sm disabled:opacity-50"
                  style={{ flexShrink: 0 }}
                >
                  {couponBusy ? "…" : "Apply"}
                </button>
              </div>
              {couponError && (
                <p
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: "var(--neg-text, #b91c1c)",
                  }}
                >
                  {couponError}
                </p>
              )}
            </div>
          )
        }
      />

      {/* Current usage strip - credits used / remaining for the cycle.
          Same shape as /settings/usage so the two screens stay in sync. */}
      {currentPlanId !== "FREE" && (
        <div className="pf-card flat" style={{ padding: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <div
              className="mono"
              style={{
                fontSize: 11,
                letterSpacing: 1.5,
                color: "var(--ink)",
                fontWeight: 700,
              }}
            >
              CURRENT USAGE
            </div>
            <span className="pf-pill emerald" style={{ fontSize: 10 }}>
              {totalRemaining} credit{totalRemaining === 1 ? "" : "s"} remaining
            </span>
            <div className="flex-1" />
            <button
              onClick={() => router.push("/settings/usage")}
              className="mono"
              style={{ fontSize: 10.5, color: "var(--emerald-text)" }}
            >
              See full usage →
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <UsageMeter
              label="PLAN CREDITS"
              used={creditsUsed}
              total={creditsLimit}
              pct={planPct}
              color="var(--emerald)"
              textColor="var(--emerald-text)"
            />
            <UsageMeter
              label="PACK CREDITS"
              used={packUsed}
              total={packLimit}
              pct={packPct}
              color="var(--pop-5)"
              textColor="var(--pop-5-text)"
              emptyHint="No packs purchased yet - buy below."
            />
          </div>
        </div>
      )}

      {/* MONEY-438: shared BillingCycleToggle so cycle state agrees with
          the Landing PricingPreview + /pricing surfaces via the ?cycle=
          URL param. Savings % is derived from the best deal across tiers
          so the headline never lies. */}
      <div className="flex items-center justify-end">
        <BillingCycleToggle
          value={billing}
          onChange={setBilling}
          savingsPct={headlineSavingsPct}
        />
      </div>

      {/* Plan cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {PLANS.map((p) => {
          const isCurrent = p.id === currentPlanId;
          // MONEY-394 L - derive per-card tone from tier ordering so
          // 'Current plan' renders on exactly one card and the others
          // get upgrade / downgrade based on direction.
          const cardTier = PLAN_TIER[p.id] ?? 0;
          const currentTier = PLAN_TIER[currentPlanId] ?? 0;
          // MONEY-481: tier-aware RECOMMENDED chip — the next tier up
          // from where the user is now. FREE→Pro, Pro→Premium,
          // Premium→nothing (Ultimate isn't shown in this grid).
          const isRecommended = !isCurrent && cardTier === currentTier + 1;
          // MONEY-481: three distinct cycle states for the user's tier
          // card so we never falsely claim "Current plan" on a cycle
          // the user isn't actually on.
          //   cycleUpsell:    monthly user, annual toggle → "Switch to annual"
          //   cycleWrongView: annual user, monthly toggle → "View annual"
          //                   (no checkout — flips toggle to user's actual cycle)
          //   else (same cycle) → disabled "Current plan"
          const cycleUpsell =
            isCurrent &&
            p.id !== "FREE" &&
            actualCycle === "monthly" &&
            billing === "annual";
          const cycleWrongView =
            isCurrent &&
            p.id !== "FREE" &&
            actualCycle === "annual" &&
            billing === "monthly";
          const isExactCurrent = isCurrent && !cycleUpsell && !cycleWrongView;
          const dynamicTone: "current" | "upgrade" | "danger" = isExactCurrent
            ? "current"
            : isCurrent && (cycleUpsell || cycleWrongView)
              ? "upgrade"
              : cardTier > currentTier
                ? "upgrade"
                : "danger";
          const dynamicCta = isExactCurrent
            ? "Current plan"
            : cycleUpsell
              ? "Switch to annual"
              : cycleWrongView
                ? "View annual plan"
                : dynamicTone === "upgrade"
                  ? `Upgrade to ${p.name}`
                  : "Downgrade";
          return (
            <div
              key={p.id}
              className="pf-card relative"
              style={{
                // MONEY-481: accent border + offset shadow follow the
                // dynamic RECOMMENDED state (next tier up from the user),
                // not a hardcoded `popular` flag. Premium users see no
                // highlighted card.
                display: "flex",
                flexDirection: "column",
                height: "100%",
                borderColor: isRecommended ? p.accent : "var(--ink)",
                boxShadow: isRecommended
                  ? `var(--shadow-soft), 0 0 40px ${p.accent}25`
                  : "var(--shadow-soft)",
              }}
            >
              {/* MONEY-481: corner chip — CURRENT on the user's tier card,
                  RECOMMENDED on the next-up card, nothing else. Color
                  tracks the tier accent. */}
              {(isCurrent || isRecommended) && (
                <div
                  className="absolute mono"
                  style={{
                    top: -11,
                    right: 16,
                    padding: "2px 10px",
                    borderRadius: 999,
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: 0.8,
                    background: p.accent,
                    color: "#16140e",
                    border: "1.5px solid var(--ink)",
                  }}
                >
                  {isCurrent ? "CURRENT" : "RECOMMENDED"}
                </div>
              )}
              {/* MONEY-438: cycle-aware discount badge. PRO is 43% off
                  monthly, 50% off annual; Premium is 50% off in both. */}
              {(() => {
                const badge =
                  billing === "annual"
                    ? formatLaunchDiscount(p.annualPrice, p.originalAnnualPrice)
                    : formatLaunchDiscount(
                        p.monthlyPrice,
                        p.originalMonthlyPrice
                      );
                return badge ? (
                  <div
                    className="absolute mono"
                    style={{
                      top: 16,
                      right: 16,
                      padding: "2px 8px",
                      borderRadius: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: 1,
                      background: "var(--pop-2)",
                      color: "#1d1d1b",
                      border: "1.5px solid var(--ink)",
                    }}
                  >
                    {badge}
                  </div>
                ) : null;
              })()}
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  marginBottom: 6,
                }}
              >
                <span
                  style={{ fontSize: 18, fontWeight: 800, color: p.accent }}
                >
                  {p.name}
                </span>
              </div>
              {/* MONEY-438: cycle-aware price block. */}
              <TierPrice plan={p} cycle={billing} />
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-3)",
                  marginBottom: 16,
                  lineHeight: 1.5,
                  minHeight: 36,
                }}
              >
                {p.blurb}
              </div>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                {p.features
                  .filter(
                    ([f]) =>
                      paperTradingEnabled ||
                      !String(f).toLowerCase().includes("paper trading")
                  )
                  .map(([f, on], i) => (
                    <div
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        fontSize: 12.5,
                        color: on ? "var(--ink-2)" : "var(--ink-4)",
                      }}
                    >
                      {on ? (
                        <Check
                          className="h-3.5 w-3.5 flex-shrink-0"
                          style={{ color: p.accent }}
                        />
                      ) : (
                        <Minus
                          className="h-3.5 w-3.5 flex-shrink-0"
                          style={{ color: "var(--ink-4)" }}
                        />
                      )}
                      <span
                        style={{
                          textDecoration: on ? "none" : "line-through",
                        }}
                      >
                        {f}
                      </span>
                    </div>
                  ))}
              </div>
              <button
                // MONEY-481: disabled only when exact match (same tier +
                // same cycle). "Switch to annual" / "View annual" stay
                // clickable.
                disabled={
                  isExactCurrent || isDemoMode || processingPlanId !== null
                }
                onClick={() => {
                  if (isExactCurrent) return;
                  // MONEY-481: cycleWrongView is purely navigational — flip
                  // the toggle back to the user's actual cycle. No checkout.
                  if (cycleWrongView) {
                    setBilling("annual");
                    return;
                  }
                  // MONEY-482: every paid-card click goes through the confirm
                  // dialog now. requestPlanChange fetches a server preview,
                  // then opens the dialog; confirm dispatches to schedule or
                  // checkout.
                  requestPlanChange(
                    p.id as "PRO" | "PREMIUM" | "FREE",
                    p.id === "FREE" ? null : billing
                  );
                }}
                className={dynamicTone === "danger" ? "pf-bf danger" : "pf-bf"}
                style={{
                  width: "100%",
                  justifyContent: "center",
                  ...(dynamicTone === "upgrade"
                    ? {
                        background: p.accent,
                        color: "#16140e",
                        borderColor: "var(--ink)",
                      }
                    : dynamicTone === "current"
                      ? {
                          background: "var(--emerald-bg)",
                          color: "var(--emerald-text)",
                          borderColor: "var(--emerald)",
                        }
                      : {}),
                  cursor: isExactCurrent || isDemoMode ? "default" : "pointer",
                  opacity: isDemoMode ? 0.5 : 1,
                }}
              >
                {processingPlanId === p.id ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Processing…
                  </>
                ) : isExactCurrent ? (
                  <>
                    <Check className="h-3.5 w-3.5" /> {dynamicCta}
                  </>
                ) : dynamicTone === "upgrade" ? (
                  <>
                    <ArrowUpRight className="h-3.5 w-3.5" /> {dynamicCta}
                  </>
                ) : (
                  <>
                    <ArrowDown className="h-3.5 w-3.5" /> {dynamicCta}
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>

      {/* Credit Packs - additional research credits. Same product set as
          the /pricing page (CREDIT_PACK_50/100/250/500/1000) wired through
          createCheckoutAction. Requires PRO or Premium. */}
      <div className="pf-card flat" style={{ padding: 18 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginBottom: 4,
          }}
        >
          <Brain className="h-4 w-4" style={{ color: "var(--pop-5-text)" }} />
          <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>
            Credit Packs
          </div>
        </div>
        <div
          style={{ fontSize: 12.5, color: "var(--ink-3)", marginBottom: 16 }}
        >
          Additional Research Credits — never expire, carry forward.
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {CREDIT_PACKS.map((pack) => {
            const processing = processingPack === pack.credits;
            const disabled =
              processing ||
              currentPlanId === "FREE" ||
              isDemoMode ||
              processingPack !== null;
            return (
              <button
                key={pack.credits}
                onClick={() => handleBuyPack(pack.credits)}
                disabled={disabled}
                className="pf-card flat"
                style={{
                  padding: 16,
                  textAlign: "center",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.5 : 1,
                  background: "var(--paper)",
                }}
              >
                <div
                  style={{ fontSize: 24, fontWeight: 800, color: "var(--ink)" }}
                >
                  {pack.credits}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    marginBottom: 8,
                  }}
                >
                  credits
                </div>
                <div
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: "var(--pop-5-text)",
                  }}
                >
                  ₹{pack.price.toLocaleString("en-IN")}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    marginBottom: 8,
                  }}
                >
                  ₹{pack.perCredit.toFixed(1)}/credit
                </div>
                <div
                  className="pf-pill violet"
                  style={{ fontSize: 11, justifyContent: "center" }}
                >
                  {processing ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" /> Processing…
                    </>
                  ) : (
                    "Buy Now"
                  )}
                </div>
              </button>
            );
          })}
        </div>
        {currentPlanId === "FREE" && (
          <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 12 }}>
            Requires PRO or Premium plan.
          </div>
        )}
      </div>

      {/* What changes if you switch */}
      <SetSection
        title="What changes if you switch"
        desc="Your data is preserved. Only access tier changes — instantly."
      >
        {[
          {
            from: "Pro → Free",
            body: paperTradingEnabled
              ? "Brokers capped to 1 (oldest kept). Paper balance reset to ₹1 L. Doc vault drops oldest beyond 5. Historical roasts & analyses stay readable."
              : "Brokers capped to 1 (oldest kept). Doc vault drops oldest beyond 5. Historical roasts & analyses stay readable.",
            color: "var(--pop-1)",
            textColor: "var(--pop-1-text)",
          },
          {
            from: "Pro → Premium",
            body: "More AI credits (200/mo). AI strategy builder unlocks. Portfolio AI analysis. Pro-rated for first month.",
            color: "var(--pop-5)",
            textColor: "var(--pop-5-text)",
          },
          {
            from: "Premium → Pro",
            body: "Credits drop to 50/mo. AI strategy builder becomes read-only. Pro features stay active until your current Premium term ends, then the downgrade takes effect.",
            color: "var(--pop-2)",
            textColor: "var(--pop-2-text)",
          },
        ].map((r, i, arr) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "14px 22px",
              borderBottom:
                i === arr.length - 1 ? 0 : "1px dashed var(--rule-soft)",
            }}
          >
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                background: `${r.color}1f`,
                border: `1.5px solid ${r.color}`,
                color: r.color,
              }}
            >
              {r.from.includes("Premium") ? (
                <ArrowUpRight className="h-3 w-3" />
              ) : (
                <ArrowDown className="h-3 w-3" />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                className="mono"
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  marginBottom: 4,
                  color: r.textColor,
                }}
              >
                {r.from}
              </div>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                }}
              >
                {r.body}
              </div>
            </div>
          </div>
        ))}
      </SetSection>

      {/* MONEY-482: explicit Cancel subscription CTA. Routes through the
          same confirm dialog as other plan changes so the user sees the
          no-refund + term-honored language before scheduling. Hidden for
          FREE-tier users and during a pending scheduled change. */}
      {currentPlanId !== "FREE" && !subscription?.scheduledPlanId && (
        <SetSection
          title="Cancel subscription"
          desc="Your current term is honored to its expiry. No refund."
        >
          <div style={{ padding: "14px 22px" }}>
            <button
              type="button"
              disabled={isDemoMode || dialogBusy}
              onClick={() => requestPlanChange("FREE", null)}
              style={{
                width: "100%",
                textAlign: "left",
                padding: "14px 18px",
                borderRadius: 10,
                border: "1.5px solid #b91c1c",
                background: "rgba(185,28,28,0.06)",
                display: "flex",
                alignItems: "center",
                gap: 12,
                cursor: isDemoMode || dialogBusy ? "not-allowed" : "pointer",
                opacity: isDemoMode || dialogBusy ? 0.5 : 1,
              }}
            >
              <ArrowDown className="h-4 w-4" style={{ color: "#b91c1c" }} />
              <div style={{ flex: 1 }}>
                <div
                  style={{ fontSize: 13.5, fontWeight: 700, color: "#b91c1c" }}
                >
                  Cancel and move to Free
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--ink-3)",
                    marginTop: 2,
                    lineHeight: 1.4,
                  }}
                >
                  You keep all paid features until the end of your current
                  billing period.
                </div>
              </div>
            </button>
          </div>
        </SetSection>
      )}
    </div>
  );
}

function UsageMeter({
  label,
  used,
  total,
  pct,
  color,
  textColor,
  emptyHint,
}: {
  label: string;
  used: number;
  total: number;
  pct: number;
  /** Bright accent used for the progress-bar fill (large graphic). */
  color: string;
  /** AA-safe text variant of the accent for the numeric label. */
  textColor: string;
  emptyHint?: string;
}) {
  return (
    <div
      style={{
        borderRadius: 8,
        border: "1.5px solid var(--rule-soft)",
        background: "var(--rule-softer)",
        padding: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span
          className="mono"
          style={{
            fontSize: 9.5,
            letterSpacing: 1,
            color: "var(--ink-3)",
            fontWeight: 700,
          }}
        >
          {label}
        </span>
        <div style={{ flex: 1 }} />
        <span
          className="mono"
          style={{ fontSize: 11.5, fontWeight: 700, color: textColor }}
        >
          {used} / {total === -1 ? "∞" : total}
        </span>
      </div>
      <div
        style={{
          height: 6,
          borderRadius: 999,
          background: "var(--paper)",
          overflow: "hidden",
          border: "1px solid var(--rule-soft)",
        }}
      >
        <div style={{ height: "100%", width: `${pct}%`, background: color }} />
      </div>
      {total === 0 && emptyHint && (
        <div
          className="mono"
          style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 8 }}
        >
          {emptyHint}
        </div>
      )}
    </div>
  );
}

/**
 * Cycle-aware price block for the plan cards (MONEY-438).
 *   - FREE: shows "₹0" + freeCopy (e.g. "forever").
 *   - Paid + Monthly: shows "₹X /month · Billed monthly".
 *   - Paid + Annual: shows monthly-annualised strikethrough + annual
 *     price + "you're saving ₹X with yearly plan" in emerald.
 *
 * Mirrors the Landing PricingPreview TierPrice so the two surfaces
 * always render the same shape — drift between them is a bug.
 */
function TierPrice({
  plan,
  cycle,
}: {
  plan: Plan;
  cycle: "monthly" | "annual";
}) {
  const priceStyle: React.CSSProperties = {
    fontSize: 32,
    fontWeight: 800,
    color: "var(--ink)",
    letterSpacing: -1,
    fontFamily: "'JetBrains Mono', monospace",
  };
  const strikeStyle: React.CSSProperties = {
    fontSize: 14,
    color: "var(--ink-4)",
    textDecoration: "line-through",
    fontFamily: "'JetBrains Mono', monospace",
  };
  const unitStyle: React.CSSProperties = {
    fontSize: 12,
    color: "var(--ink-3)",
    fontFamily: "'JetBrains Mono', monospace",
  };

  // FREE tier
  if (plan.monthlyPrice == null || plan.annualPrice == null) {
    return (
      <div style={{ marginBottom: 4 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={priceStyle}>₹0</span>
          <span style={unitStyle}>{plan.freeCopy ?? "forever"}</span>
        </div>
      </div>
    );
  }

  if (cycle === "monthly") {
    return (
      <div style={{ marginBottom: 4 }}>
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            flexWrap: "wrap",
          }}
        >
          <span style={priceStyle}>
            ₹{plan.monthlyPrice.toLocaleString("en-IN")}
          </span>
          {plan.originalMonthlyPrice != null && (
            <span style={strikeStyle}>
              ₹{plan.originalMonthlyPrice.toLocaleString("en-IN")}
            </span>
          )}
          <span style={unitStyle}>/month</span>
        </div>
        <div style={{ ...unitStyle, fontSize: 11, marginTop: 2 }}>
          Billed monthly
        </div>
      </div>
    );
  }

  // Annual: mirrors /pricing card shape.
  const monthlyEquivalent = Math.round(plan.annualPrice / 12);
  const savedAbs = formatSavingsAbsolute({
    monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice,
  });
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        <span style={priceStyle}>
          ₹{plan.annualPrice.toLocaleString("en-IN")}
        </span>
        {plan.originalAnnualPrice != null && (
          <span style={strikeStyle}>
            ₹{plan.originalAnnualPrice.toLocaleString("en-IN")}
          </span>
        )}
        <span style={unitStyle}>/year</span>
      </div>
      <div
        className="mono"
        style={{ fontSize: 11, color: "var(--pop-2-text)", marginTop: 2 }}
      >
        ₹{monthlyEquivalent.toLocaleString("en-IN")}/month · Billed annually
      </div>
      {savedAbs && (
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--emerald-text)" }}
        >
          Save {savedAbs}/year
        </div>
      )}
    </div>
  );
}

/**
 * Pick the best (highest) savings % across paid tiers for the toggle
 * "Save X%" badge. Free tiers skip. Returns null if no paid tier has
 * positive annual savings.
 */
function pickHeadlineSavings(plans: Plan[]): number | null {
  let best: number | null = null;
  for (const p of plans) {
    if (p.monthlyPrice == null || p.annualPrice == null) continue;
    const pct = formatSavingsPct({
      monthlyPrice: p.monthlyPrice,
      annualPrice: p.annualPrice,
    });
    if (!pct) continue;
    const num = parseInt(pct, 10);
    if (Number.isFinite(num) && (best == null || num > best)) best = num;
  }
  return best;
}
