/**
 * Tool Executor - pure logic
 *
 * The side-effect-free helpers used by `executor.ts` live here so they can be
 * unit-tested under `node:test` WITHOUT importing the chat-tool registry, which
 * transitively pulls server actions → `lib/auth.ts` (`react.cache`) and cannot
 * load in a bare Node test. `executor.ts` imports and calls these, so the
 * production path and the tests execute the SAME code (no shadow).
 */

/**
 * Sanitize error messages before they reach the user.
 * Strips stack traces, connection strings, and internal paths.
 */
export function sanitizeToolError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "An unexpected error occurred. Please try again.";
  }

  const msg = error.message;

  // Redact known sensitive patterns
  if (
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("getaddrinfo")
  ) {
    return "A required service is temporarily unavailable. Please try again in a moment.";
  }

  if (msg.includes("prisma") || msg.includes("mongodb")) {
    return "A database error occurred. Please try again.";
  }

  if (msg.includes("401") || msg.includes("Unauthorized")) {
    return "Your session may have expired. Please refresh and try again.";
  }

  if (msg.includes("429") || msg.includes("rate limit")) {
    return "Too many requests. Please wait a moment and try again.";
  }

  // For other errors, use the message but cap length and strip paths
  const cleaned = msg
    .replace(/\/[^\s]+\.[jt]sx?/g, "[file]") // Strip file paths
    .replace(/at\s+.+\(.+\)/g, "") // Strip stack frames
    .slice(0, 200);

  return cleaned || "An error occurred while executing the action.";
}

/**
 * Generate a user-friendly confirmation message for a write/long-running tool.
 */
export function generateConfirmation(
  toolName: string,
  params: Record<string, unknown>
): string {
  switch (toolName) {
    case "create_fire_scenario":
      return `Create a new FIRE scenario "${params.name}" (age ${params.currentAge} → ${params.retirementAge}, corpus ₹${params.currentCorpus})?`;
    case "buy_paper_position":
      return `Buy ${params.quantity} shares of ${params.symbol} at ₹${params.price} in paper trading?`;
    case "sell_paper_position":
      return `Sell paper position at ₹${params.price}?`;
    case "run_research": {
      // MONEY-1073 — a single-fund run carries a `[MUTUAL_FUND] <name>` query
      // and a numeric AMFI scheme-code symbol; show the fund NAME, not the code.
      const query = typeof params.query === "string" ? params.query : "";
      const fundName = query.startsWith("[MUTUAL_FUND]")
        ? query.slice("[MUTUAL_FUND]".length).trim()
        : "";
      const symbolStr =
        Array.isArray(params.symbols) && params.symbols.length > 0
          ? params.symbols.join(", ")
          : null;
      const label = fundName || symbolStr || query || "this stock";
      return `Start ${params.mode === "advanced" ? "comprehensive" : "quick"} research on ${label}?`;
    }
    default:
      return "Confirm this action?";
  }
}
