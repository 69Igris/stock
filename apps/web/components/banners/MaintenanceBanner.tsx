"use client";

/**
 * MaintenanceBanner — playful (MONEY-484).
 *
 * Ink (.pf-banner.maint) full-width strip for scheduled maintenance
 * notices. Rotated clock icon on a transparent-white bg, gold title
 * accent, white body, gold "Got it" dismiss button.
 * Design source: .pf-banner.maint (screens-qa-essentials.jsx).
 */

import { useState } from "react";
import { Clock, X } from "lucide-react";
import "./banners.css";

export interface MaintenanceBannerProps {
  /**
   * Short description of the window, e.g. "tonight, 11 PM — 12 AM IST"
   * Rendered as serif italic after the gold "Scheduled maintenance · " prefix.
   */
  window: string;
  /**
   * Optional extra detail line, e.g. "Broker sync pauses for an hour. Reads stay up."
   */
  detail?: string;
  /** Optional URL for a status page. */
  statusHref?: string;
  onDismiss?: () => void;
  className?: string;
}

export default function MaintenanceBanner({
  window: maintenanceWindow,
  detail,
  statusHref,
  onDismiss,
  className,
}: MaintenanceBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  if (dismissed) return null;

  return (
    <div
      className={`pf-banner maint${className ? ` ${className}` : ""}`}
      role="status"
      aria-label="Scheduled maintenance notice"
    >
      {/* Rotated clock icon — semi-transparent white bg, gold icon */}
      <div className="ic" aria-hidden>
        <Clock size={15} />
      </div>

      {/* Copy */}
      <div className="body">
        <div className="t" style={{ color: "var(--pop-2)" }}>
          Scheduled maintenance ·{" "}
          <span className="ser" style={{ color: "var(--paper)" }}>
            {maintenanceWindow}
          </span>
        </div>
        {(detail || statusHref) && (
          <div className="s">
            {detail}
            {detail && statusHref ? " " : ""}
            {statusHref && (
              <a
                href={statusHref}
                style={{ color: "var(--pop-2)", textDecoration: "underline" }}
                target="_blank"
                rel="noopener noreferrer"
              >
                Status page
              </a>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="actions">
        <button
          type="button"
          className="btn-bn"
          onClick={handleDismiss}
          style={{ borderColor: "var(--pop-2)", color: "var(--pop-2)" }}
        >
          Got it
        </button>
      </div>

      {/* Dismiss X */}
      <button
        type="button"
        className="x"
        onClick={handleDismiss}
        aria-label="Dismiss maintenance banner"
      >
        <X size={14} />
      </button>
    </div>
  );
}
