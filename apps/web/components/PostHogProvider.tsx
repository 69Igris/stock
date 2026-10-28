"use client";

import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import type PostHogLib from "posthog-js";

/**
 * Patterns we DON'T want in PostHog error tracking - they're either:
 * - Browser extension noise (MS Office Outlook, ad blockers)
 * - Known harmless browser quirks (ResizeObserver loop)
 * - Cross-origin script errors (no stack trace, can't act on them)
 * - CDN flakes outside our control (Clerk JS bundle timeouts)
 */
const SUPPRESSED_EXCEPTION_PATTERNS = [
  /Object Not Found Matching Id:\d+, MethodName:update, ParamCount:\d+/,
  /ResizeObserver loop/,
  /^Script error\.?$/,
  /Loading chunk \d+ failed.*clerk\.usemoney\.ai/,
];

function shouldSuppressException(message: unknown): boolean {
  if (typeof message !== "string") return false;
  return SUPPRESSED_EXCEPTION_PATTERNS.some((p) => p.test(message));
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser();
  const [client, setClient] = useState<typeof PostHogLib | null>(null);
  const initRef = useRef(false);

  useEffect(() => {
    if (initRef.current || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return;
    initRef.current = true;

    // Lazy-load posthog-js (~80KB) - only after first paint
    import("posthog-js")
      .then(({ default: posthog }) => {
        posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
          api_host: "/ingest",
          ui_host: "https://us.posthog.com",
          defaults: "2025-05-24",
          capture_exceptions: true,
          // posthog-js' own verbose logger — the "[FeatureFlags]"/"[Surveys]"
          // notices and the "TypeError: Failed to fetch" + retry lines that show
          // up when a browser ad-blocker/shield blocks the /ingest path — is gated
          // behind this flag. Default OFF (incl. dev) so local consoles stay clean;
          // opt in with NEXT_PUBLIC_POSTHOG_DEBUG=true to actually debug PostHog.
          debug: process.env.NEXT_PUBLIC_POSTHOG_DEBUG === "true",
          // MONEY-1084: MUST be "history_change", not `true`.
          //
          // UseMoney is an App Router SPA — moving between /dashboard, /holdings,
          // /tradebook etc. never reloads the page. `true` is posthog-js's LEGACY
          // load-only behaviour, so we captured one pageview per session and
          // every client-side route change was invisible. Prod bore this out:
          // 475 pageviews across 441 sessions over 14 days (~1.08 per session),
          // which is why a reproducible navigation bug (MONEY-1082) left no trace
          // in analytics and why any multi-route funnel was measuring landings.
          //
          // Note `defaults: "2025-05-24"` above already resolves this to
          // "history_change" (posthog-js: `!(v && v >= "2025-05-24") ||
          // "history_change"`) — passing `true` explicitly was OVERRIDING that
          // back to the legacy path. Kept explicit rather than deleted so the
          // intent survives a future `defaults` bump.
          capture_pageview: "history_change",
          capture_pageleave: true,
          before_send: (event) => {
            // Drop known-noise exceptions client-side (saves bandwidth + cleans dashboard)
            if (event?.event === "$exception") {
              const values = event.properties?.$exception_values;
              const message = Array.isArray(values) ? values[0] : undefined;
              if (shouldSuppressException(message)) {
                return null; // null = drop event
              }
            }
            return event;
          },
        });
        setClient(posthog);
      })
      // MONEY-1220 — analytics must not reject into the void. `import()`
      // REJECTS when the chunk cannot be fetched, and unguarded that becomes an
      // `unhandledRejection: ChunkLoadError`. Reachable in ordinary conditions:
      // an ad blocker on `/ingest`, a deploy rotating chunk hashes with a tab
      // open, or a dev server recompiling mid-navigation.
      //
      // `client` stays null on failure, and the component already renders
      // `{children}` unwrapped in that case — so the app degrades to "no
      // analytics" rather than to a broken tree.
      .catch((err: unknown) => {
        console.warn("[posthog] init skipped — chunk unavailable", err);
      });
  }, []);

  useEffect(() => {
    if (!client || !isLoaded) return;

    if (user) {
      const email = user.emailAddresses?.[0]?.emailAddress;
      const userId = user.id;

      if (email && userId) {
        client.identify(userId, {
          email,
          name: user.fullName || user.firstName || email,
          firstName: user.firstName,
          lastName: user.lastName,
          username: user.username,
          createdAt: user.createdAt,
        });
        client.reloadFeatureFlags();
        client.capture("user_signed_in", { email, method: "clerk" });
      }
    } else {
      client.reset();
    }
  }, [user, isLoaded, client]);

  if (!client) return <>{children}</>;
  return <PHProvider client={client}>{children}</PHProvider>;
}
