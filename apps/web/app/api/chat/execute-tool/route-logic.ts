/**
 * Pure request-validation + result-shaping logic for the chat execute-tool
 * route.
 *
 * Extracted from `./route.ts` (which imports Clerk + the chat-tools registry,
 * and so transitively pulls server-only `react.cache` — unimportable from a
 * unit test) so the route's own contract is tested against the REAL exported
 * symbols it calls, not inline copies:
 *   - body shape gate (`tool` + `actionId` required),
 *   - the confirm-UUID `actionId` format gate (must be a `confirm-<uuid>` minted
 *     by the chat route — `app/api/chat/route.ts`),
 *   - the async-poll / write-confirm tool sets that decide whether terminal
 *     result blocks are rendered server-side (MONEY-587).
 *
 * Tool existence / confirmation / category remain the registry's job
 * (`@/lib/chat-tools/registry`) — duplicating that table here would just be a
 * new shadow.
 *
 * @see apps/web/__tests__/api/chat-execute-tool.test.ts
 */

/** Minimal shape of the JSON body POSTed to /api/chat/execute-tool. */
export interface ExecuteToolBody {
  tool?: unknown;
  params?: unknown;
  actionId?: unknown;
}

/**
 * Validate that the request carries both a `tool` and an `actionId`. Mirrors
 * the route's `if (!toolName || !actionId)` gate (so empty strings fail too).
 */
export function validateExecuteToolRequest(body: ExecuteToolBody): {
  valid: boolean;
  error?: string;
} {
  if (!body.tool || !body.actionId) {
    return { valid: false, error: "tool and actionId are required" };
  }
  return { valid: true };
}

/**
 * The `actionId` must be a confirm-UUID minted by the chat route
 * (`confirm-${randomUUID()}`). Guards against replaying arbitrary client
 * strings as confirmations. `confirm-` (8) + a v4 UUID (36) = 44 chars, so the
 * `>= 40` length floor is satisfied by any genuine id.
 */
export function isValidConfirmActionId(actionId: unknown): boolean {
  return (
    typeof actionId === "string" &&
    actionId.startsWith("confirm-") &&
    actionId.length >= 40
  );
}

/**
 * Mint a synthetic `confirm-slash-<uuid>` actionId for slash-command direct
 * dispatch (which bypasses the chat route's normal confirm step). Co-located
 * with `isValidConfirmActionId` so the format the client mints always satisfies
 * the validator the route enforces. `ChatContext.executeToolDirect` calls this.
 *
 * `confirm-slash-` (14) + a v4 UUID (36) = 50 chars, comfortably past the
 * validator's `>= 40` floor; the `crypto`-less branch keeps the prefix + a long
 * enough random tail.
 */
export function synthesizeSlashActionId(): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `confirm-slash-${suffix}`;
}

/**
 * Async tools return a sessionId/scanId and the client polls them — the
 * execute-tool route must NOT render terminal result blocks for these.
 */
export const POLLED_TOOLS = new Set<string>([
  "run_research",
  "start_roast",
  "run_comprehensive_analysis",
  "run_strategy_scan",
]);

/**
 * Write/confirmation tools have no list to render but DO get a confirmation
 * line so the chat reads naturally.
 */
export const WRITE_CONFIRM_TOOLS = new Set<string>([
  "buy_paper_position",
  "sell_paper_position",
  "create_fire_scenario",
  "create_strategy",
  "generate_report",
]);

/**
 * Tools whose deterministic summary IS the whole answer — they have no list /
 * typed block to render (`buildListToolBlocks` returns []), so the route must
 * still emit the narrated text block for them (MONEY-887: summarize_post).
 */
export const NARRATIVE_TOOLS = new Set<string>(["summarize_post"]);

/**
 * Whether the route should deterministically render result blocks for a
 * completed tool: only successful, non-polled tools (the polled ones resolve
 * asynchronously and are rendered when the client fetches their result).
 */
export function shouldRenderResultBlocks(
  toolName: string,
  success: boolean
): boolean {
  return success && !POLLED_TOOLS.has(toolName);
}
