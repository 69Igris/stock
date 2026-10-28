"use client";

/**
 * TrialEndingBanner — playful (MONEY-484).
 *
 * Gold (.pf-banner.trial) full-width strip. Shown when the user's PRO
 * trial is nearing expiry. Rotated crown icon on ink bg, serif accent in
 * copy, ink-coloured buttons (to ensure contrast on the gold ground),
 * optional dismiss. Design source: .pf-banner.trial
 * (screens-qa-essentials.jsx).
 */

import { useState } from "react";
import { Crown, X } from "lucide-react";
import Link from "next/link";
import "./banners.css";

export interface TrialEndingBannerProps {
  /** e.g. "4 days" */
  daysLeft: number;
  /** e.g. 38 credits used */
  creditsUsed?: number;
  /** e.g. 50 credits total */
  creditsTotal?: number;
  /** Optional upgrade URL — defaults to /pricing */
  upgradeHref?: string;
  onDismiss?: () => void;
  className?: string;
}

export default function TrialEndingBanner({
  daysLeft,
  creditsUsed,
  creditsTotal,
  upgradeHref = "/pricing",
  onDismiss,
  className,
}: TrialEndingBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  if (dismissed) return null;

  const dayLabel = daysLeft === 1 ? "1 day" : `${daysLeft} days`;
  const creditsNote =
    creditsUsed !== undefined && creditsTotal !== undefined
      ? ` You used ${creditsUsed} of ${creditsTotal} credits this month.`
      : "";

  return (
    <div
      className={`pf-banner trial${className ? ` ${className}` : ""}`}
      role="status"
      aria-label="PRO trial ending soon"
    >
      {/* Rotated icon square — ink bg with gold icon for contrast on gold ground */}
      <div className="ic" aria-hidden>
        <Crown size={15} />
      </div>

      {/* Copy */}
      <div className="body">
        <div className="t">
          PRO trial ends in <span className="ser">{dayLabel}.</span>
        </div>
        <div className="s">
          {creditsNote} Lock in 50% off — PRO is ₹249/mo with annual billing.
        </div>
      </div>

      {/* Actions — explicit ink colours for contrast on gold ground */}
      <div className="actions">
        <Link
          href={upgradeHref}
          className="btn-bn"
          style={{ borderColor: "#1d1d1b", color: "#1d1d1b" }}
        >
          See plans
        </Link>
        <Link
          href={upgradeHref}
          className="btn-bn solid"
          style={{ background: "#1d1d1b", borderColor: "#1d1d1b" }}
        >
          <span>Upgrade now →</span>
        </Link>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        className="x"
        onClick={handleDismiss}
        aria-label="Dismiss trial banner"
        style={{ color: "#1d1d1b" }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
