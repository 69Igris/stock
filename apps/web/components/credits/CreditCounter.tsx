"use client";

import { Gem, ShoppingCart } from "lucide-react";
import Link from "next/link";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@usemoney/ui/tooltip";

interface CreditCounterProps {
  /** Total remaining credits (plan + pack) */
  remaining: number;
  /**
   * The allowance `remaining` is measured against — it MUST span the same
   * allowances, i.e. plan + pack.
   *
   * MONEY-1199 — this prop used to be named for the PLAN allowance, and every
   * caller duly passed `subscriptionAccess.creditsLimit`, which is the plan
   * figure alone, while `remaining` spans plan AND pack. For anyone who had
   * bought a query pack the two disagreed: the chat rendered
   * "2750 / 200 credits", a remaining count larger than its own limit, and
   * `isLow` compared a plan+pack figure against 10% of the plan, so the
   * low-credit warning fired at the wrong point too. Renamed so the next caller
   * cannot pick the wrong field by trusting the prop name.
   */
  limit: number;
  /** Credits used */
  used?: number;
  /** Total credits available (plan + pack) */
  total?: number;
  /** Whether to show the Buy More link */
  showBuyMore?: boolean;
  /** Custom className */
  className?: string;
  /** Compact mode (no label, just number) */
  compact?: boolean;
  /** Callback when Buy More is clicked */
  onBuyMore?: () => void;
}

/**
 * Credit Counter — playful re-skin (MONEY-484).
 *
 * Uses pf-pill token styles from playful-app.css.
 * Badge colour tracks low/empty state (emerald → gold → coral).
 */
export function CreditCounter({
  remaining,
  limit,
  used,
  total,
  showBuyMore = true,
  className,
  compact = false,
  onBuyMore,
}: CreditCounterProps) {
  const isLow = remaining <= Math.max(5, limit * 0.1);
  const isEmpty = remaining <= 0;

  // Map state → token
  const badgeBg = isEmpty
    ? "var(--pop-1)"
    : isLow
      ? "var(--pop-2)"
      : "var(--emerald-bg)";
  const badgeColor = isEmpty
    ? "var(--paper)"
    : isLow
      ? "#1d1d1b"
      : "var(--emerald-text)";
  const badgeBorder = isEmpty
    ? "var(--pop-1)"
    : isLow
      ? "var(--pop-2)"
      : "var(--emerald)";

  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "3px 9px",
                borderRadius: 999,
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                fontWeight: 700,
                border: `1.5px solid ${badgeBorder}`,
                background: badgeBg,
                color: badgeColor,
                cursor: "default",
                letterSpacing: "0.5px",
              }}
            >
              <Gem style={{ width: 11, height: 11 }} />
              {compact ? (
                <span>{remaining}</span>
              ) : (
                <span>
                  {remaining}
                  {isEmpty && " · empty"}
                </span>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            style={{
              background: "var(--paper)",
              border: "2px solid var(--ink)",
              borderRadius: 8,
              boxShadow: "var(--shadow-soft)",
              padding: "8px 12px",
            }}
          >
            <div
              className="mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12,
                color: "var(--ink-2)",
              }}
            >
              <Gem
                style={{ width: 12, height: 12, color: "var(--emerald-text)" }}
              />
              Credits: {used ?? 0}/{total ?? limit} used
            </div>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {showBuyMore &&
        isEmpty &&
        (onBuyMore ? (
          <button
            type="button"
            className="pf-bf sm"
            style={{ fontSize: 11, padding: "3px 9px" }}
            onClick={onBuyMore}
          >
            <ShoppingCart style={{ width: 11, height: 11 }} />
            Buy More
          </button>
        ) : (
          <Link href="/settings?tab=subscription">
            <button
              type="button"
              className="pf-bf sm"
              style={{ fontSize: 11, padding: "3px 9px" }}
            >
              <ShoppingCart style={{ width: 11, height: 11 }} />
              Buy More
            </button>
          </Link>
        ))}
    </div>
  );
}
