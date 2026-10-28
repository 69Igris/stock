/**
 * Pure logic for content-generation actions (extracted from
 * content-generation.ts).
 *
 * The generate/verify server actions are thin try/catch wrappers around an
 * async content-engine call: on success they return `{ success, data }`, on
 * failure `{ success: false, error }` using the thrown Error's message or a
 * per-action fallback. That wrapping is extracted here so it can be unit
 * tested without importing the action (which drags Clerk + the content-engine
 * Gemini stack). Both actions call `runContentAction`.
 *
 * @see apps/admin/__tests__/actions/content-generation.test.ts
 */

export type ContentActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

/**
 * Runs an async content-engine operation, returning a success/error result.
 * On a thrown Error the message is surfaced; otherwise the provided fallback
 * is used.
 */
export async function runContentAction<T>(
  fn: () => Promise<T>,
  fallback: string,
): Promise<ContentActionResult<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : fallback,
    };
  }
}
