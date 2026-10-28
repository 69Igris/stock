"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import "./empty-state.css";

interface EmptyAction {
  label: string;
  onClick?: () => void;
  href?: string;
}

interface EmptyStateProps {
  /** Lucide icon component shown in the rotated accent square. */
  icon: LucideIcon;
  title: string;
  description: React.ReactNode;
  /** Accent colour for the icon square (CSS var or hex). Ignored when `muted`. */
  color?: string;
  /** Muted treatment — neutral square, no hard shadow (e.g. "no search matches"). */
  muted?: boolean;
  /** Primary CTA → renders as `pf-bs` (or `pf-bf` when muted). */
  action?: EmptyAction;
  /** Secondary CTA → renders as `pf-bf`, placed before the primary. */
  secondaryAction?: EmptyAction;
  /** Render inside its own `pf-card` (default). Set false to drop the card chrome. */
  card?: boolean;
  className?: string;
}

function ActionButton({
  action,
  variant,
}: {
  action: EmptyAction;
  variant: "pf-bs" | "pf-bf";
}) {
  const cls = `${variant} sm`;
  if (action.href) {
    return (
      <Link href={action.href} className={cls}>
        {action.label}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} onClick={action.onClick}>
      {action.label}
    </button>
  );
}

/**
 * Playful empty state — rotated accent icon square, bold title, serif-italic
 * subtitle and up to two CTAs. Mirrors the design's "When there's nothing to
 * show" surfaces. Shared across holdings, tradebook, chat, watchlist, screener,
 * strategies, etc. New CSS lives in the co-located `empty-state.css`.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  color = "var(--emerald)",
  muted = false,
  action,
  secondaryAction,
  card = true,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`pf-empty ${card ? "pf-empty-card pf-card" : ""} ${className}`}
    >
      <div
        className={`pf-empty-ic ${muted ? "is-muted" : ""}`}
        style={muted ? undefined : { background: color }}
      >
        <Icon size={26} strokeWidth={2} />
      </div>
      <div className="pf-empty-t">{title}</div>
      <div className="pf-empty-s ser">{description}</div>
      {(action || secondaryAction) && (
        <div className="pf-empty-actions">
          {secondaryAction && (
            <ActionButton action={secondaryAction} variant="pf-bf" />
          )}
          {action && (
            <ActionButton action={action} variant={muted ? "pf-bf" : "pf-bs"} />
          )}
        </div>
      )}
    </div>
  );
}

export default EmptyState;
