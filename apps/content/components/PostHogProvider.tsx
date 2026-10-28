"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";

// Analytics run in production only. In local dev the first-party `/ingest`
// proxy requests are routinely blocked by ad-blockers / privacy extensions,
// which floods the console with "[PostHog.js] Failed to fetch … Enqueued for
// retry" noise (harmless, but drowns out real logs). QA/preview/prod all run
// with NODE_ENV=production, so they still get analytics. To force-enable in dev
// for debugging, temporarily flip this guard.
const ANALYTICS_ENABLED =
  process.env.NODE_ENV === "production" &&
  !!process.env.NEXT_PUBLIC_POSTHOG_KEY;

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();

  useEffect(() => {
    if (ANALYTICS_ENABLED) {
      posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
        api_host: "/ingest",
        ui_host: "https://us.posthog.com",
        defaults: "2025-05-24",
        capture_exceptions: true,
        debug: process.env.NODE_ENV === "development",
        capture_pageview: true,
        capture_pageleave: true,
        loaded: () => {
          console.log("[PostHog] Successfully initialized");
        },
      });
    }
  }, []);

  useEffect(() => {
    if (!ANALYTICS_ENABLED) return;
    if (isLoaded && user) {
      const email = user.emailAddresses?.[0]?.emailAddress;
      if (email) {
        posthog.identify(user.id, {
          email,
          name: user.fullName || user.firstName || email,
          firstName: user.firstName,
          lastName: user.lastName,
        });
      }
    } else if (isLoaded && !user) {
      posthog.reset();
    }
  }, [user, isLoaded]);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
