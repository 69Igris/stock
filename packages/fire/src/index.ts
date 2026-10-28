/**
 * @usemoney/fire — the framework-free FIRE chat engine + domain primitives.
 *
 * Extracted from apps/web (MONEY-1079) so both the web app (via a server
 * action) and apps/api (mobile, via a Hono route) reuse ONE engine. Nothing
 * here imports React, Next, Clerk, or Prisma — persistence + the model call are
 * injected by the caller (see runFireChatTurn's `generate` param and
 * ServerFireActions' scenario ops).
 *
 * Per-file subpaths (`@usemoney/fire/parser`, `/serverTurn`, …) exist for the
 * web page's existing re-export shims; new code imports from this barrel.
 */

// ── Domain primitives ────────────────────────────────────────────────────
export * from "./types";
export * from "./bounds";
export * from "./calculations";
export * from "./rebalance";

// ── The chat engine ──────────────────────────────────────────────────────
export * from "./actions";
export * from "./parser";
export * from "./systemPrompt";
export * from "./tools";
export * from "./toolExecutor";
export * from "./serverActions";
export * from "./serverSnapshot";
export * from "./serverTurn";
export * from "./scenarioTarget";
