"use client";

import { CreditCounter } from "@/components/credits/CreditCounter";

export interface SubscriptionAccess {
  fastQueriesUsed: number;
  fastQueriesLimit: number;
  advancedQueriesUsed: number;
  advancedQueriesLimit: number;
  canAccessAIQueries: boolean;
  // Unified credits
  creditsUsed?: number;
  creditsLimit?: number;
  packCreditsUsed?: number;
  packCreditsLimit?: number;
}

interface ChatQuerySelectorProps {
  /** @deprecated No longer used - system auto-selects */
  queryType: "fast" | "advanced";
  /** @deprecated No longer used */
  onQueryTypeChange: (queryType: "fast" | "advanced") => void;
  subscriptionAccess: SubscriptionAccess | null;
  className?: string;
  disabled?: boolean;
  /** Callback when Buy More is clicked */
  onBuyMore?: () => void;
}

/**
 * Chat Query Selector Component
 *
 * MIGRATED: The Fast/Advanced toggle is replaced with a unified credit counter.
 * The system now auto-selects the analysis depth based on the query.
 * Props `queryType` and `onQueryTypeChange` are kept for backward compat but ignored.
 */
export function ChatQuerySelector({
  subscriptionAccess,
  className,
  onBuyMore,
}: ChatQuerySelectorProps) {
  if (!subscriptionAccess) {
    return null;
  }

  // Use unified credits if available, fall back to legacy calculation
  const creditsUsed = subscriptionAccess.creditsUsed ?? 0;
  const creditsLimit = subscriptionAccess.creditsLimit ?? 0;
  const packUsed = subscriptionAccess.packCreditsUsed ?? 0;
  const packLimit = subscriptionAccess.packCreditsLimit ?? 0;

  const planRemaining = Math.max(0, creditsLimit - creditsUsed);
  const packRemaining = Math.max(0, packLimit - packUsed);
  const totalRemaining = planRemaining + packRemaining;

  // If unified credits not populated yet, estimate from legacy fields
  const hasUnifiedCredits = creditsLimit > 0 || creditsUsed > 0;
  const legacyRemaining = hasUnifiedCredits
    ? totalRemaining
    : Math.max(
        0,
        subscriptionAccess.fastQueriesLimit === -1
          ? 999
          : subscriptionAccess.fastQueriesLimit -
              subscriptionAccess.fastQueriesUsed
      );

  return (
    <div className={className}>
      <CreditCounter
        remaining={hasUnifiedCredits ? totalRemaining : legacyRemaining}
        // MONEY-1199 — plan + pack, matching what `remaining` spans.
        // `packLimit` above is this exact expression; deriving it twice is how a
        // later change to one copy silently un-fixes the other (MONEY-1199).
        limit={creditsLimit + packLimit}
        showBuyMore={true}
        onBuyMore={onBuyMore}
      />
    </div>
  );
}

/**
 * Get query mode description
 * @deprecated System auto-selects - no user choice needed
 */
export function getQueryModeDescription(
  queryType: "fast" | "advanced"
): string {
  return "AI automatically selects the best analysis depth for your query.";
}

/**
 * Get query mode badge color
 * @deprecated
 */
export function getQueryModeBadgeVariant(
  queryType: "fast" | "advanced"
): "default" | "secondary" {
  return "default";
}
