"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useUser } from "@clerk/nextjs";
import { usePostHog } from "posthog-js/react";
import { Card, CardContent, CardHeader, CardTitle } from "@usemoney/ui/card";
import { Button } from "@usemoney/ui/button";
import { Badge } from "@usemoney/ui/badge";
import { CheckCircle, XCircle, AlertCircle, RefreshCw } from "lucide-react";

export default function PostHogDebugClient() {
  const { user, isLoaded } = useUser();
  const posthog = usePostHog();
  const [flags, setFlags] = useState<Record<string, boolean | undefined>>({});
  const [isRefreshing, setIsRefreshing] = useState(false);

  // MONEY-394: only currently-gated routes are listed here. The legacy
  // page-visibility-tradebook/positions/holdings/discover/analysis flags
  // were retired (routes are now in ALWAYS_ON_ROUTES) - keeping them on
  // the debug page just surfaced perpetual `Not Set` rows.
  const flagKeys = useMemo(
    () => [
      "page-visibility-paper-trading",
      "page-visibility-sage-tutor",
      "page-visibility-learning",
      "page-visibility-risk",
      "page-visibility-tax",
      "page-visibility-documents",
      "page-visibility-strategies",
      "page-visibility-quizzes",
      // US/international gates (single-user scoped today)
      "us-stocks-listing",
      "us-stocks-search",
      "us-broker-ib",
      "global-mf",
      "us-stock-research",
    ],
    []
  );

  const checkFlags = useCallback(() => {
    setIsRefreshing(true);
    const newFlags: Record<string, boolean | undefined> = {};
    flagKeys.forEach((key) => {
      const value = posthog?.isFeatureEnabled(key);
      newFlags[key] = value;
      console.log(`[Debug] Flag ${key}:`, {
        raw: value,
        type: typeof value,
        isUndefined: value === undefined,
        isTrue: value === true,
        isFalse: value === false,
      });
    });

    // Also check all feature flags from PostHog
    console.log("[Debug] All PostHog feature flags:", posthog?.getFeatureFlag);
    console.log(
      "[Debug] Feature flag payloads:",
      posthog?.getFeatureFlagPayload
    );

    setFlags(newFlags);
    setTimeout(() => setIsRefreshing(false), 500);
  }, [posthog, flagKeys]);

  useEffect(() => {
    if (posthog?.__loaded) {
      checkFlags();
    }
  }, [posthog?.__loaded, checkFlags]);

  const testEvent = () => {
    posthog?.capture("debug_test_event", {
      test: true,
      timestamp: new Date().toISOString(),
    });
    alert("Test event sent! Check PostHog dashboard in a few seconds.");
  };

  const reloadFlags = () => {
    posthog?.reloadFeatureFlags();
    setTimeout(checkFlags, 1000);
  };

  const isPostHogReady = posthog?.__loaded;
  const userEmail = user?.emailAddresses?.[0]?.emailAddress;
  const userId = user?.id;

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold text-foreground mb-2">
            PostHog Debug Page
          </h1>
          <p className="text-muted-foreground">
            Check PostHog integration status and feature flags
          </p>
        </div>

        {/* PostHog Status */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground flex items-center gap-2">
              PostHog Status
              {isPostHogReady ? (
                <CheckCircle className="h-5 w-5 text-green-500" />
              ) : (
                <XCircle className="h-5 w-5 text-red-500" />
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-foreground/80">PostHog Loaded:</span>
              <Badge variant={isPostHogReady ? "default" : "destructive"}>
                {isPostHogReady ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground/80">API Key Set:</span>
              <Badge
                variant={
                  process.env.NEXT_PUBLIC_POSTHOG_KEY
                    ? "default"
                    : "destructive"
                }
              >
                {process.env.NEXT_PUBLIC_POSTHOG_KEY ? "Yes" : "No"}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground/80">Distinct ID:</span>
              <span className="text-muted-foreground text-sm font-mono">
                {posthog?.get_distinct_id() || "Not set"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* User Status */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground flex items-center gap-2">
              User Status
              {isLoaded && user ? (
                <CheckCircle className="h-5 w-5 text-green-500" />
              ) : (
                <AlertCircle className="h-5 w-5 text-yellow-500" />
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-foreground/80">Clerk User Loaded:</span>
              <Badge variant={isLoaded ? "default" : "secondary"}>
                {isLoaded ? "Yes" : "Loading..."}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-foreground/80">User Authenticated:</span>
              <Badge variant={user ? "default" : "secondary"}>
                {user ? "Yes" : "No"}
              </Badge>
            </div>
            {user && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/80">Email:</span>
                  <span className="text-muted-foreground text-sm">
                    {userEmail}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/80">User ID:</span>
                  <span className="text-muted-foreground text-sm font-mono">
                    {userId}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-foreground/80">
                    PostHog Identified:
                  </span>
                  <Badge
                    variant={
                      posthog?.get_distinct_id() === userId
                        ? "default"
                        : "destructive"
                    }
                  >
                    {posthog?.get_distinct_id() === userId ? "Yes" : "No"}
                  </Badge>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        {/* Feature Flags */}
        <Card className="bg-card border-border">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-foreground">Feature Flags</CardTitle>
            <Button
              onClick={reloadFlags}
              size="sm"
              variant="outline"
              disabled={isRefreshing}
              className="border-border text-foreground/80"
            >
              <RefreshCw
                className={`h-4 w-4 mr-2 ${isRefreshing ? "animate-spin" : ""}`}
              />
              Reload Flags
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {flagKeys.map((key) => {
              const value = flags[key];
              return (
                <div
                  key={key}
                  className="flex items-center justify-between py-2 border-b border-border last:border-0"
                >
                  <span className="text-foreground/80 text-sm font-mono">
                    {key}
                  </span>
                  <div className="flex items-center gap-2">
                    {value === undefined ? (
                      <Badge variant="secondary">Not Set (Default: true)</Badge>
                    ) : value === true ? (
                      <Badge variant="default" className="bg-green-600">
                        Enabled
                      </Badge>
                    ) : (
                      <Badge variant="destructive">Disabled</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Actions */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Test Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button
              onClick={testEvent}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={!isPostHogReady}
            >
              Send Test Event
            </Button>
            <Button
              onClick={() => {
                window.open("https://us.posthog.com/events", "_blank");
              }}
              variant="outline"
              className="w-full border-border text-foreground/80"
            >
              Open PostHog Dashboard
            </Button>
          </CardContent>
        </Card>

        {/* Instructions */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Troubleshooting</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-foreground/80 text-sm">
            <div>
              <strong className="text-foreground">PostHog not loading?</strong>
              <ul className="list-disc list-inside mt-1 space-y-1 text-muted-foreground">
                <li>Check browser console for errors</li>
                <li>Verify NEXT_PUBLIC_POSTHOG_KEY in .env</li>
                <li>Check if ad-blocker is blocking PostHog</li>
                <li>Ensure /ingest proxy is working</li>
              </ul>
            </div>
            <div>
              <strong className="text-foreground">User not identified?</strong>
              <ul className="list-disc list-inside mt-1 space-y-1 text-muted-foreground">
                <li>Make sure you&apos;re signed in (not demo mode)</li>
                <li>Check PostHogProvider is wrapping the app</li>
                <li>Verify useUser() from Clerk returns user data</li>
              </ul>
            </div>
            <div>
              <strong className="text-foreground">
                Feature flags not working?
              </strong>
              <ul className="list-disc list-inside mt-1 space-y-1 text-muted-foreground">
                <li>Create the feature flags in PostHog dashboard first</li>
                <li>Ensure flag keys match exactly (case-sensitive)</li>
                <li>Wait a few seconds after creating flags</li>
                <li>Click &quot;Reload Flags&quot; button above</li>
              </ul>
            </div>
          </CardContent>
        </Card>

        {/* Console Logs */}
        <Card className="bg-card border-border">
          <CardHeader>
            <CardTitle className="text-foreground">Console Logs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Check your browser console (F12) for detailed logs:
            </p>
            <ul className="list-disc list-inside mt-2 space-y-1 text-muted-foreground text-sm">
              <li>[PostHog] Successfully initialized</li>
              <li>[PostHog] Identifying user</li>
              <li>[FeatureFlags] PostHog loaded, fetching feature flags...</li>
              <li>[FeatureFlags] All flags loaded</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
