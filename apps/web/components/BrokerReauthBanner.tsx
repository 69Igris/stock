"use client";

/**
 * BrokerReauthBanner — playful re-skin (MONEY-484).
 *
 * Full-width strip with 2px ink bottom border, rotated coral icon square,
 * serif accent in copy, outline + solid action buttons, dismiss X.
 * Design source: .pf-banner.reauth (screens-qa-essentials.jsx).
 * All colours are playful tokens — theme-aware via html.dark.
 * Props and dismiss behaviour are unchanged.
 *
 * MONEY-489 multi-broker extension (backward-compatible):
 * - New optional `brokers` prop accepts an array of { name, reauthUrl }.
 * - When `brokers` has > 1 entry, renders a combined "N brokers need
 *   re-authorisation" banner with a separate re-authorise link per broker.
 * - When `brokers` has 0 or 1 entry, or is omitted, falls back to the
 *   original single-broker render (uses the existing `brokerName` /
 *   `reauthUrl` scalar props). All existing call sites remain untouched.
 */

import { useState } from "react";
import { AlertTriangle, X, ExternalLink } from "lucide-react";
import "@/components/banners/banners.css";

interface BrokerReauthEntry {
  name: string;
  reauthUrl: string;
}

interface BrokerReauthBannerProps {
  /** Original single-broker props — kept for backward compat. */
  brokerName: string;
  reauthUrl: string;
  className?: string;
  /**
   * Optional multi-broker list. When provided with > 1 entry, overrides
   * the single-broker layout and renders a combined banner.
   */
  brokers?: BrokerReauthEntry[];
}

export default function BrokerReauthBanner({
  brokerName,
  reauthUrl,
  className,
  brokers,
}: BrokerReauthBannerProps) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  /* ── Multi-broker path ── */
  if (brokers && brokers.length > 1) {
    return (
      <div
        className={`pf-banner reauth${className ? ` ${className}` : ""}`}
        role="alert"
        aria-label={`${brokers.length} brokers need re-authorisation`}
      >
        {/* Rotated icon square */}
        <div className="ic" aria-hidden>
          <AlertTriangle size={15} />
        </div>

        {/* Copy */}
        <div className="body">
          <div className="t">
            {brokers.length} brokers{" "}
            <span className="ser">need re-authorisation.</span>
          </div>
          <div className="s">
            Sync is paused for these accounts.{" "}
            <strong>You&apos;ll lose nothing</strong> — only the sync stops.
          </div>
        </div>

        {/* Per-broker action links */}
        <div className="actions" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-bn"
            onClick={() => setDismissed(true)}
          >
            Remind me later
          </button>
          {brokers.map((b) => (
            <a key={b.name} href={b.reauthUrl} className="btn-bn solid">
              <span>
                Re-authorise {b.name} →{" "}
                <ExternalLink
                  size={11}
                  style={{ display: "inline", verticalAlign: "middle" }}
                />
              </span>
            </a>
          ))}
        </div>

        {/* Dismiss */}
        <button
          type="button"
          className="x"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss banner"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  /* ── Single-broker path (original behaviour — unchanged) ── */
  // If `brokers` array has exactly 1 entry, use that entry's fields;
  // otherwise fall back to the scalar brokerName / reauthUrl props so
  // every existing call site continues to work with zero changes.
  const effectiveName =
    brokers && brokers.length === 1 ? brokers[0].name : brokerName;
  const effectiveUrl =
    brokers && brokers.length === 1 ? brokers[0].reauthUrl : reauthUrl;

  return (
    <div
      className={`pf-banner reauth${className ? ` ${className}` : ""}`}
      role="alert"
      aria-label={`${effectiveName} re-authorisation required`}
    >
      {/* Rotated icon square */}
      <div className="ic" aria-hidden>
        <AlertTriangle size={15} />
      </div>

      {/* Copy */}
      <div className="body">
        <div className="t">
          {effectiveName} token <span className="ser">expired.</span>
        </div>
        <div className="s">
          Sync is paused. Re-authorise to keep your tradebook up to date.{" "}
          <strong>You&apos;ll lose nothing</strong> — only the sync stops.
        </div>
      </div>

      {/* Actions */}
      <div className="actions">
        <button
          type="button"
          className="btn-bn"
          onClick={() => setDismissed(true)}
        >
          Remind me later
        </button>
        <a href={effectiveUrl} className="btn-bn solid">
          <span>
            Re-authorise {effectiveName} →{" "}
            <ExternalLink
              size={11}
              style={{ display: "inline", verticalAlign: "middle" }}
            />
          </span>
        </a>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        className="x"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss banner"
      >
        <X size={14} />
      </button>
    </div>
  );
}
