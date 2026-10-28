"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@usemoney/ui/card";
import { Button } from "@usemoney/ui/button";
import { Badge } from "@usemoney/ui/badge";
import { Lock, Crown, Sparkles, ArrowRight } from "lucide-react";
import {
  PLAN_NAMES,
  resolveAccess,
  resolveRenderPath,
} from "./feature-gate-logic";

interface FeatureGateProps {
  feature: string;
  requiredPlan: "PRO" | "PREMIUM" | "ULTIMATE";
  children: React.ReactNode;
  fallback?: React.ReactNode;
  showUpgradePrompt?: boolean;
}

export default function FeatureGate({
  feature,
  requiredPlan,
  children,
  fallback,
  showUpgradePrompt = true,
}: FeatureGateProps) {
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [currentPlan, setCurrentPlan] = useState<string>("FREE");
  const [isLoading, setIsLoading] = useState(true);

  const checkAccess = useCallback(async () => {
    const demoMode =
      typeof window !== "undefined" &&
      localStorage.getItem("tradebook_demo_mode") === "true";
    try {
      let fetchResult: Parameters<typeof resolveAccess>[1];
      if (demoMode) {
        // resolveAccess short-circuits on demoMode; fetchResult is unused.
        fetchResult = { ok: false };
      } else {
        const response = await fetch("/api/subscription/access");
        fetchResult = response.ok
          ? { ok: true, data: await response.json() }
          : { ok: false };
      }
      const { hasAccess: granted, currentPlan: plan } = resolveAccess(
        demoMode,
        fetchResult,
        requiredPlan
      );
      setCurrentPlan(plan);
      setHasAccess(granted);
    } catch (error) {
      console.error("Failed to check access:", error);
      const { hasAccess: granted, currentPlan: plan } = resolveAccess(
        demoMode,
        "error",
        requiredPlan
      );
      setCurrentPlan(plan);
      setHasAccess(granted);
    } finally {
      setIsLoading(false);
    }
  }, [requiredPlan]);

  useEffect(() => {
    checkAccess();
  }, [checkAccess]);

  const renderPath = resolveRenderPath(
    isLoading,
    hasAccess,
    fallback != null,
    showUpgradePrompt
  );

  if (renderPath === "loading") {
    return <div className="animate-pulse bg-muted rounded-lg h-32"></div>;
  }
  if (renderPath === "children") {
    return <>{children}</>;
  }
  if (renderPath === "fallback") {
    return <>{fallback}</>;
  }
  if (renderPath === "null") {
    return null;
  }

  return (
    <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-border">
      <CardContent className="p-6 text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center">
          <Lock className="h-6 w-6 text-amber-500" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">
          {feature}
        </h3>
        <p className="text-muted-foreground text-sm mb-4">
          This feature requires the{" "}
          <Badge className="bg-blue-500/20 text-blue-400">
            {requiredPlan === "PRO" ? (
              <Crown className="h-3 w-3 mr-1" />
            ) : (
              <Sparkles className="h-3 w-3 mr-1" />
            )}
            {PLAN_NAMES[requiredPlan]}
          </Badge>{" "}
          plan
        </p>
        <Button
          asChild
          className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800"
        >
          <Link href="/pricing">
            Upgrade Now <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

// HOC version for wrapping pages
export function withFeatureGate<P extends object>(
  Component: React.ComponentType<P>,
  feature: string,
  requiredPlan: "PRO" | "PREMIUM" | "ULTIMATE"
) {
  return function WrappedComponent(props: P) {
    return (
      <FeatureGate feature={feature} requiredPlan={requiredPlan}>
        <Component {...props} />
      </FeatureGate>
    );
  };
}
