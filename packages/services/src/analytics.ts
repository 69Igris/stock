/**
 * Service-layer analytics helper.
 *
 * Mirrors the apps/web posthog pattern (per-call client, flushAt:1) but
 * stays inside the services package so heal/credit/recovery events can
 * be captured at their source. Env-gated: no-op when
 * NEXT_PUBLIC_POSTHOG_KEY is unset (workers/CI/tests).
 *
 * Telemetry must never break service logic - all errors are swallowed.
 */

import { PostHog } from "posthog-node";

/**
 * Fire-and-forget PostHog event from inside a service function.
 *
 * @param distinctId - User ID or "anonymous"
 * @param event - PostHog event name (snake_case, e.g. "subscription_self_healed")
 * @param properties - Event properties (will be visible in PostHog filters)
 */
export function captureServiceEvent(
  distinctId: string,
  event: string,
  properties: Record<string, unknown> = {},
): void {
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return;

  try {
    const client = new PostHog(apiKey, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    });
    client.capture({ distinctId, event, properties });
    void client.shutdown();
  } catch {
    // Telemetry must never break service logic.
  }
}
