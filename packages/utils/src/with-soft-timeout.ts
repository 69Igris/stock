/**
 * Soft-timeout wrapper - MONEY-239 G.
 *
 * Vercel serverless functions die at the 60s mark on the Pro plan and
 * Hobby tier. Long-running L2-fast research narratives that take 30+
 * seconds risk getting cut mid-stream. This helper wraps an async op
 * with a soft warning timer that fires telemetry BEFORE the hard
 * timeout - so we can see in PostHog how often we're flirting with
 * the limit, and route those users to the worker-backed Pub/Sub path
 * on the next attempt.
 *
 *   const result = await withSoftTimeout(
 *     () => generateWithTimeout(model, prompt),
 *     {
 *       softMs: 25_000,
 *       eventName: "research_fast_slow",
 *       userId,
 *       metadata: { intent: "narrative" },
 *     },
 *   );
 *
 * Doesn't abort the underlying op - just records that it crossed the
 * soft threshold. The hard timeout (`generateWithTimeout`'s own 30s
 * default) still kicks in if needed.
 */

interface SoftTimeoutOptions {
  /** When to fire the telemetry event. Default 25 000 (25 s). */
  softMs?: number;
  /** PostHog event name. Required so each call site is distinguishable. */
  eventName: string;
  /** Optional userId for the PostHog event distinct_id. */
  userId?: string;
  /** Extra properties attached to the PostHog event. */
  metadata?: Record<string, unknown>;
}

export async function withSoftTimeout<T>(
  fn: () => Promise<T>,
  opts: SoftTimeoutOptions,
): Promise<T> {
  const softMs = opts.softMs ?? 25_000;
  const startedAt = Date.now();
  let crossedSoft = false;

  const timer = setTimeout(() => {
    crossedSoft = true;
    // Fire-and-forget PostHog. We import lazily to avoid pulling the
    // server-only PostHog client into client bundles that may import
    // this util.
    void emitPostHogEvent(opts.eventName, {
      distinct_id: opts.userId ?? "anonymous",
      properties: {
        soft_ms: softMs,
        ...opts.metadata,
      },
    }).catch(() => {
      /* swallow - telemetry should never break the request */
    });
  }, softMs);

  try {
    const out = await fn();
    return out;
  } finally {
    clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (crossedSoft) {
      // Replace the threshold-crossed event with a final-with-duration
      // event so PostHog has both signals: when we crossed, and how
      // long we ultimately took. Lets us measure whether the soft
      // threshold is the right place to escalate from.
      void emitPostHogEvent(`${opts.eventName}_completed`, {
        distinct_id: opts.userId ?? "anonymous",
        properties: {
          soft_ms: softMs,
          actual_ms: elapsedMs,
          ...opts.metadata,
        },
      }).catch(() => {});
    }
  }
}

async function emitPostHogEvent(
  event: string,
  payload: { distinct_id: string; properties: Record<string, unknown> },
): Promise<void> {
  // Server-side PostHog. Inline import keeps the helper safe for
  // edge / client bundles that only need the type.
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) return;
  const host =
    process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";
  try {
    await fetch(`${host}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        event,
        ...payload,
        timestamp: new Date().toISOString(),
      }),
    });
  } catch {
    // Same swallow as above; telemetry is best-effort.
  }
}
