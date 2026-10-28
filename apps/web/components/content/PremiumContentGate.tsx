"use client";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent } from "@usemoney/ui/card";
import { Button } from "@usemoney/ui/button";
import { Badge } from "@usemoney/ui/badge";
import { Lock, Crown, ArrowRight, Eye } from "lucide-react";

interface PremiumContentGateProps {
  /** Whether this content requires a premium subscription */
  isPremium: boolean;
  /** Content to display */
  children: React.ReactNode;
  /** Optional custom locked message */
  lockedMessage?: string;
  /** Whether to show a preview of the content with blur effect */
  showPreview?: boolean;
  /** Custom preview height (default: 200px) */
  previewHeight?: number;
}

/**
 * PremiumContentGate - Paywall component for premium content
 *
 * Shows content normally for free content or subscribed users.
 * For premium content with non-subscribed users, shows an upgrade CTA
 * with an optional blurred preview of the content.
 */
export function PremiumContentGate({
  isPremium,
  children,
  lockedMessage = "This content is exclusive to Premium members",
  showPreview = true,
  previewHeight = 200,
}: PremiumContentGateProps) {
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const checkAccess = useCallback(async () => {
    // If content is not premium, allow access immediately
    if (!isPremium) {
      setHasAccess(true);
      setIsLoading(false);
      return;
    }

    try {
      // Check for demo mode
      if (
        typeof window !== "undefined" &&
        localStorage.getItem("tradebook_demo_mode") === "true"
      ) {
        setHasAccess(true);
        setIsLoading(false);
        return;
      }

      const response = await fetch("/api/subscription/access");
      if (response.ok) {
        const data = await response.json();
        // PRO, PREMIUM, and ULTIMATE plans have premium access
        const tier: Record<string, number> = {
          FREE: 0,
          PRO: 1,
          PREMIUM: 2,
          ULTIMATE: 3,
        };
        setHasAccess((tier[data.planId] ?? 0) >= 1);
      } else {
        setHasAccess(false);
      }
    } catch (error) {
      console.error("Failed to check subscription access:", error);
      setHasAccess(false);
    } finally {
      setIsLoading(false);
    }
  }, [isPremium]);

  useEffect(() => {
    checkAccess();
  }, [checkAccess]);

  // Loading state
  if (isLoading) {
    return <div className="animate-pulse bg-muted rounded-lg h-32" />;
  }

  // User has access - render content normally
  if (hasAccess) {
    return <>{children}</>;
  }

  // User doesn't have access - show paywall
  return (
    <div className="relative">
      {/* Preview with blur effect */}
      {showPreview && (
        <div
          className="relative overflow-hidden rounded-lg"
          style={{ maxHeight: previewHeight }}
        >
          <div className="blur-sm pointer-events-none select-none">
            {children}
          </div>
          {/* Gradient fade overlay */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-slate-900/50 to-slate-900" />
        </div>
      )}

      {/* Upgrade CTA Card */}
      <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border mt-4">
        <CardContent className="p-6 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
            <Lock className="h-6 w-6 text-amber-500" />
          </div>

          <h3 className="text-lg font-semibold text-foreground mb-2">
            Premium Content
          </h3>

          <p className="text-muted-foreground text-sm mb-4">{lockedMessage}</p>

          <div className="flex items-center justify-center gap-2 mb-4">
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
              <Crown className="h-3 w-3 mr-1" />
              Premium Required
            </Badge>
          </div>

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/pricing">
              <Button className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800">
                Upgrade to Premium
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>

            {showPreview && (
              <Button variant="outline" className="border-border" disabled>
                <Eye className="mr-2 h-4 w-4" />
                Preview Only
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default PremiumContentGate;
