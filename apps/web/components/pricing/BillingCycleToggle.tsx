"use client";

/**
 * MONEY-438 / Pricing v2: shared Monthly/Yearly toggle.
 *
 * Visual spec: pill toggle with a white-bg slider on the active side
 * (reference design 2026-05-21). The unselected side is muted text on
 * the dark wrapper. The Yearly side carries a "Save X%" badge that
 * stays visible regardless of selection so users see the deal anchor
 * even before they touch it.
 *
 * State is owned externally by the `useBillingCycle` hook so this
 * component is purely presentational. The hook handles URL persistence
 * (?cycle=annual) and SSR-safe hydration.
 *
 * Used across:
 *   - Landing PricingPreview
 *   - /pricing client
 *   - /settings/plans PlansTab
 */

import type { BillingCycle } from "@/lib/pricing/useBillingCycle";

export interface BillingCycleToggleProps {
  /** Currently selected cycle. */
  value: BillingCycle;
  /** Called when the user picks a different cycle. */
  onChange: (next: BillingCycle) => void;
  /**
   * Annual-side savings as a whole-number percentage (e.g. 40).
   * Pass null to hide the badge.
   */
  savingsPct?: number | null;
  /** Wrapper className override per surface. */
  className?: string;
  /** Disable both options (e.g. when a cycle change is in flight). */
  disabled?: boolean;
}

export default function BillingCycleToggle({
  value,
  onChange,
  savingsPct,
  className,
  disabled = false,
}: BillingCycleToggleProps) {
  const wrapperCls = className ? `${BASE_WRAPPER} ${className}` : BASE_WRAPPER;

  return (
    <div
      role="tablist"
      aria-label="Billing cycle"
      className={wrapperCls}
      data-testid="billing-cycle-toggle"
    >
      <Pill
        active={value === "monthly"}
        onClick={() => !disabled && onChange("monthly")}
        disabled={disabled}
        label={<span>Monthly</span>}
      />
      <Pill
        active={value === "annual"}
        onClick={() => !disabled && onChange("annual")}
        disabled={disabled}
        label={
          <span className="inline-flex items-center gap-2">
            Yearly
            {savingsPct != null && savingsPct > 0 && (
              <span
                className={`font-mono font-bold text-[10px] tracking-[0.4px] px-1.5 py-[2px] rounded-full uppercase border ${
                  value === "annual"
                    ? "bg-emerald-400/[0.15] text-emerald-400 border-emerald-400/40"
                    : "bg-emerald-400/[0.10] text-emerald-400 border-emerald-400/30"
                }`}
              >
                Save {savingsPct}%
              </span>
            )}
          </span>
        }
      />
    </div>
  );
}

// Theme-aware wrapper: in light mode a tinted dark wash gives the pill
// something to contrast against; in dark mode the original white alpha
// wash still reads correctly. Using alpha keeps both modes "glassy"
// instead of flat-filled.
const BASE_WRAPPER =
  "inline-flex items-center rounded-full border border-[var(--border-default)] bg-black/[0.04] dark:bg-white/[0.03] p-1 gap-1";

function Pill({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  label: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`px-5 py-2 rounded-full text-[13px] font-semibold transition-all ${
        disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"
      } ${
        active
          ? // Light mode: dark pill on light wash (slate-900 → near-black).
            // Dark mode: original white pill on dark wash.
            "bg-[#0f172a] text-white shadow-[0_2px_8px_rgba(15,23,42,0.18)] dark:bg-white dark:text-[#16140e] dark:shadow-[0_2px_8px_rgba(0,0,0,0.25)]"
          : "text-[var(--text-dim)] hover:text-[var(--text-primary)]"
      }`}
    >
      {label}
    </button>
  );
}
