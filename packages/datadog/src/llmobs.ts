/**
 * LLM Observability workflow wrapper — MONEY-1380.
 *
 * ## What this buys, in one call
 *
 * dd-trace auto-instruments `@google/genai` and `@anthropic-ai/sdk`, so every
 * model call already produces an LLM span once the tracer is wired. What the
 * SDK cannot know is WHICH FEATURE the call belongs to, and that is the
 * grouping (`ml_app`) every dashboard, monitor and cost breakdown in LLM Obs
 * hangs off.
 *
 * `ml_app` resolves as
 *   explicit ‖ parent LLMObs span's ‖ propagated tag ‖ config ‖ service name
 * (`dd-trace/src/llmobs/tagger.js`), so wrapping ONE entry point per feature
 * tags every model call underneath it — including calls several packages deep
 * that this file never sees. That inheritance is pinned by
 * `__tests__/llmobs-wired.test.ts` against a real tracer, not assumed.
 *
 * An unwrapped call site is not lost: it lands under the service name
 * (`stockbook-workers`, `stockbook-web`, `stockbook-api`), which reads as a
 * visible "not yet attributed" bucket. That is deliberate — the long tail of
 * ~12 small web actions stays unwrapped until observed spend says which of them
 * are worth their own row.
 *
 * ## Why a wrapper rather than calling the SDK directly
 *
 * The OFF state, and NOT because a bare call would crash — it would not.
 * Measured: on an uninitialised tracer `tracer.llmobs` is a noop object whose
 * `enabled` getter is `false` (`dd-trace/src/noop/proxy.js` assigns
 * `this.llmobs = noopLLMObs`), and calling `trace()` on it returns normally.
 *
 * What the wrapper buys is that the feature path does not open, tag and
 * discard a span per call on every local dev shell and CI run, and that the
 * decision reads as one line at the call site. The `?.` is belt-and-braces
 * against a future dd-trace where the property is genuinely absent — which is
 * the shape `lazyProxy(this, 'llmobs', …)` inside
 * `if (config.tracing !== false)` (`dd-trace/src/proxy.js`) suggests it could
 * become.
 */

import { tracer } from "./tracer";

/**
 * The `ml_app` vocabulary. One value per user-facing feature, NOT one per
 * service or per package — a research run spans `packages/research`, the worker
 * and the web preview route, and it is one thing to the person paying for it.
 *
 * Adding a value here is cheap; renaming one is not, because it splits a
 * feature's history in the LLM Obs UI at the rename.
 */
export type MlApp =
  | "research"
  | "briefing"
  | "analysis"
  | "roast"
  | "doc-ingest"
  | "video"
  | "chat"
  | "fire";

export interface LlmWorkflowOptions {
  /**
   * Groups every model call in one user-visible run under a single trace —
   * a research session id, a chat id. Optional: pass it where the caller
   * already has one, never invent one.
   */
  sessionId?: string;
}

/**
 * Run `fn` as an LLM Observability *workflow* span tagged with `mlApp`.
 *
 * A pure pass-through when LLM Obs is not enabled: `fn` is called exactly once
 * and its value returned, with nothing touched on the tracer.
 *
 * ## Declare the wrapper `async`, always
 *
 * Not style. A Next.js `"use server"` module requires every export to be an
 * `async function` — a plain function returning a Promise is rejected AT BUILD
 * TIME with "Server Actions must be async functions", which no type-checker
 * catches because the types are identical. Keeping every wrapper in this repo
 * `async` means the shape someone copies is the one that builds.
 *
 * @example
 * export async function fooAction(input: In): Promise<Out> {
 *   return llmWorkflow("research", "research-run", () => runAgent(input), {
 *     sessionId: input.sessionId,
 *   });
 * }
 */
export function llmWorkflow<T>(
  mlApp: MlApp,
  name: string,
  fn: () => Promise<T>,
  options: LlmWorkflowOptions = {},
): Promise<T> {
  // The tracer's OWN state is the gate, rather than a second read of
  // `DD_LLMOBS_ENABLED` here. Two independent parses of one env var is the
  // shape where a picker and a route disagree and the product silently does
  // something other than what it displayed (MONEY-1274). `enabled` is a getter
  // over `config.llmobs.enabled`, which is what dd-trace itself branches on.
  const llmobs = tracer.llmobs;
  if (!llmobs?.enabled) return fn();

  // No cast: dd-trace declares `trace<T>(options, fn): T`, so the generic
  // carries `Promise<T>` straight through. An `as` here would hide a real
  // mismatch if that signature ever changed.
  return llmobs.trace({ kind: "workflow", name, mlApp, ...options }, () =>
    fn(),
  );
}
