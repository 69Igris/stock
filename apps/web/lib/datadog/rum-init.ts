// MONEY-1229 — the site is ONE constant, shared with the server-side emitters.
// A RUM init pointed at a different site than the API key was minted on is
// answered 403 and dropped silently; the org moved us3 -> us5 in Sep 2026.
import { DD_SITE } from "@usemoney/datadog/constants";

/**
 * The `datadogRum.init()` argument, or `null` when the public env is absent
 * (local dev, and previews built without the NEXT_PUBLIC_DD_* pair).
 *
 * MONEY-726 — this lives in its own leaf module because it now has TWO callers
 * that can never share a React tree: `DatadogRumProvider`, mounted inside
 * `app/layout.tsx`, and `app/global-error.tsx`, which replaces the document
 * when the layout itself throws and therefore has no provider above it. A
 * second copy of this object in the crash page is a second copy that drifts —
 * and the way it drifts is silent, because a boundary reporting to the wrong
 * `service`/`env` still returns 200 and simply lands where nobody is looking.
 *
 * Deliberately a leaf: its only import is a string constant, so `global-error`
 * can pull it in dynamically without dragging any of the app (Clerk, the CSS
 * bundle, the sidebar) into the one page that must render when all of that is
 * already broken.
 */
export function rumInitConfig() {
  const applicationId = process.env.NEXT_PUBLIC_DD_APPLICATION_ID;
  const clientToken = process.env.NEXT_PUBLIC_DD_CLIENT_TOKEN;
  if (!applicationId || !clientToken) return null;
  return {
    applicationId,
    clientToken,
    site: DD_SITE,
    service: "stockbook-web",
    env: process.env.NEXT_PUBLIC_DD_ENV || "production",
    version: process.env.NEXT_PUBLIC_DD_VERSION || "1.0.0",
    sessionSampleRate: 100,
    sessionReplaySampleRate: 20,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: "mask-user-input" as const,
    allowedTracingUrls: [
      {
        match: (url: string) =>
          /https:\/\/.*\.usemoney\.ai/.test(url) &&
          !url.includes("clerk.usemoney.ai"),
        propagatorTypes: ["datadog" as const],
      },
    ],
  };
}
