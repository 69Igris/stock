/**
 * Bounded-concurrency mapping (MONEY-712).
 *
 * ## Why this is a separate, pure module
 *
 * The concurrency bound in `syncBrokerConnections` was originally inline, and
 * the only thing guarding it was a source-text regex asserting that
 * `connections.slice(` appeared somewhere. A review mutated the service to
 * `const chunkSize = connections.length` — full unbounded fan-out, exactly what
 * the bound exists to prevent — and all 51 tests stayed green.
 *
 * A regex cannot observe concurrency. Extracting the windowing here makes the
 * property BEHAVIOURAL: a test can watch peak in-flight count and fail when it
 * exceeds the limit, which is the thing we actually care about.
 *
 * ## Semantics
 *
 * - Runs `task` over `items` with at most `limit` in flight.
 * - Results are returned in INPUT order, regardless of completion order. The
 *   broker sync surfaces `perConnection` per-broker in the UI, so a reordering
 *   would be user-visible.
 * - Does NOT catch. A task that rejects rejects the whole call, deliberately:
 *   callers that need per-item isolation (broker sync does) catch inside their
 *   own task and resolve to a result object. Swallowing here would silently
 *   convert their failures into undefined holes.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  // A limit below 1 would stall forever rather than degrade; clamp it, since
  // the alternative is a hang that looks like a slow network.
  const width = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);

  // Index-cursor workers rather than fixed chunks: with chunks, a window waits
  // for its slowest member before the next starts, so one slow broker idles
  // the other three. Workers keep `width` tasks in flight continuously.
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, () => worker()),
  );

  return results;
}
