"use client";

/**
 * MONEY-383: Client-side demo funnel beacon.
 *
 * Reads the non-HttpOnly `sb_demo_did` cookie (set alongside `sb_demo` in
 * /api/demo/start) and identifies the demo distinctId to PostHog so all
 * subsequent client-side events (including the auto-captured `$pageview`)
 * are stitched into the same demo person record.
 *
 * Also exposes `trackDemoCtaClick(label)` for components that want to log
 * `demo_cta_clicked` events with a specific surface label.
 */

import { useEffect } from "react";
import { usePostHog } from "posthog-js/react";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((row) => row.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.split("=")[1] ?? "") : null;
}

/**
 * Use inside any layout/page that's reachable in demo mode. Idempotent -
 * calling it multiple times doesn't re-identify if the distinctId hasn't
 * changed.
 */
export function useDemoAnalytics(): void {
  const posthog = usePostHog();

  useEffect(() => {
    if (!posthog) return;
    const did = readCookie("sb_demo_did");
    if (!did) return;
    // Cheap dedupe - posthog.identify is internally idempotent but we still
    // want to avoid extra network chatter on every mount.
    const current = posthog.get_distinct_id?.();
    if (current === did) return;
    posthog.identify(did, { is_demo: true });
  }, [posthog]);
}

/**
 * Fire a `demo_cta_clicked` event. Safe to call when no demo cookie is
 * present (no-ops).
 */
export function trackDemoCtaClick(
  label: string,
  extras?: Record<string, unknown>
): void {
  if (typeof window === "undefined") return;
  const did = readCookie("sb_demo_did");
  if (!did) return;
  // Lazy import to avoid pulling posthog-js into pages that don't need it.
  import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.capture("demo_cta_clicked", {
        label,
        ...(extras ?? {}),
      });
    })
    // MONEY-1220 — analytics must not reject into the void. A blocked or
    // rotated chunk otherwise surfaces as `unhandledRejection: ChunkLoadError`,
    // and an ad blocker is enough to trigger it. Losing one CTA event is fine;
    // an unhandled rejection on a marketing page is not.
    .catch(() => {});
}
