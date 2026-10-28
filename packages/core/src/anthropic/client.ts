/**
 * Anthropic Claude client — MONEY-506 (BAD-1, Claude-live slice).
 *
 * Thin wrapper over the official `@anthropic-ai/sdk` Messages API (lazy
 * singleton, mirroring `payments/dodo.ts`'s `getDodoClient`). The SDK gives
 * us retries, timeouts and typed errors for free; the slice keeps using one
 * non-streaming call. BAD-1b (MONEY-626) layers per-agent/per-tier routing +
 * streaming/tool-use on top — the call sites only depend on the shapes below.
 *
 * Scope of the slice: ONE agent (research portfolio-analysis synthesis)
 * routes to Claude Sonnet; everything else stays Gemini. See
 * `packages/research/src/model-selection.ts`.
 *
 * Env:
 *   ANTHROPIC_API_KEY        — enables the slice when present
 *   CLAUDE_PORTFOLIO_AGENT   — set "off" to force Gemini (kill switch)
 */

import Anthropic from "@anthropic-ai/sdk";
import { geminiLogger as logger } from "@usemoney/logger";

/** Claude Sonnet 4.6 — the slice's model (per the eval/routing plan). */
export const CLAUDE_SONNET_ID = "claude-sonnet-4-6";

/**
 * Opus 4.6+ are reasoning models that DEPRECATE the `temperature` param — the
 * Messages API 400s if it's sent (Sonnet 4.6 still accepts it). Found via the
 * MONEY-508 eval. Guard so a future caller that passes a temperature can't 400
 * an Opus route; the request simply omits it (the model runs at its default).
 */
function modelSupportsTemperature(model: string): boolean {
  return !/^claude-opus-4-[6-9]/.test(model);
}

/** Per-request timeout (ms). The research layer also wraps with its own. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * `isClaudeConfigured` lives in the SDK-free `./access` module (so the client
 * bundle can read it without pulling @anthropic-ai/sdk); re-exported here for
 * the server callers + tests that import it from the client.
 */
export { isClaudeConfigured } from "./access";

// ── lazy singleton (mirror getDodoClient) ────────────────────────────────
let _client: Anthropic | null = null;

/** Lazily construct the SDK client; throws if the key is absent. */
export function getAnthropicClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!_client) {
    _client = new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  }
  return _client;
}

/** Reset the singleton (tests / key rotation). */
export function resetAnthropicClient(): void {
  _client = null;
}

// ── test seam ────────────────────────────────────────────────────────────
// The slice's only network call is messages.create; overriding it lets the
// unit tests assert request shape + error mapping with no SDK/network, the
// same spirit as the repo's other DI seams.
type MessagesCreateFn = (
  body: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;
let _createForTests: MessagesCreateFn | null = null;

/** Override (or clear with null) the messages.create call. Tests only. */
export function __setClaudeCreateForTests(fn: MessagesCreateFn | null): void {
  _createForTests = fn;
}

// Streaming test seam — yields text deltas, no SDK/network.
type StreamTextFn = (params: ClaudeGenerateParams) => AsyncIterable<string>;
let _streamForTests: StreamTextFn | null = null;

/** Override (or clear with null) the streaming call. Tests only. */
export function __setClaudeStreamForTests(fn: StreamTextFn | null): void {
  _streamForTests = fn;
}

export interface ClaudeGenerateParams {
  /** Model id; defaults to Sonnet 4.6. */
  model?: string;
  /** System prompt (kept separate per the Messages API contract). */
  system?: string;
  /** Single user turn — the slice is one-shot synthesis, not a chat. */
  prompt: string;
  /** Defaults to 8192 — research synthesis reports are long. */
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ClaudeGenerateResult {
  text: string;
  model: string;
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Pull a sanitized "<status> (<type>)" out of an SDK error WITHOUT leaking
 * the key, the prompt, or the raw body. Duck-typed on `.status` + the parsed
 * `.error` body (shaped `{ error: { type } }`) rather than
 * `instanceof Anthropic.APIError` — a dual-package / bundle boundary can hand
 * us a second SDK copy where instanceof silently fails, and this slice is
 * bundled into the worker.
 */
function sanitizeAnthropicError(err: unknown): string {
  const e = err as { status?: unknown; error?: unknown; name?: unknown };
  const status = typeof e?.status === "number" ? e.status : "error";
  let type = "unknown";
  const body = e?.error;
  if (body && typeof body === "object") {
    const inner = body as { error?: { type?: unknown }; type?: unknown };
    if (typeof inner.error?.type === "string") type = inner.error.type;
    else if (typeof inner.type === "string") type = inner.type;
  } else if (typeof e?.name === "string" && e.name && e.name !== "Error") {
    type = e.name;
  }
  return `Anthropic API ${status} (${type})`;
}

/**
 * One-shot generation against the Messages API.
 *
 * Throws on HTTP/transport errors with a sanitized message (status +
 * Anthropic error type only — never the key, never the body), so the
 * caller's fallback path (Gemini) can take over cleanly.
 */
export async function claudeGenerate(
  params: ClaudeGenerateParams,
): Promise<ClaudeGenerateResult> {
  // Explicit pre-check so the error is stable regardless of SDK internals
  // (and so the kill-switch/no-key path never constructs a client).
  if (!process.env.ANTHROPIC_API_KEY && !_createForTests) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const model = params.model ?? CLAUDE_SONNET_ID;
  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: params.maxOutputTokens ?? 8192,
    messages: [{ role: "user", content: params.prompt }],
    ...(params.temperature !== undefined && modelSupportsTemperature(model)
      ? { temperature: params.temperature }
      : {}),
    ...(params.system ? { system: params.system } : {}),
  };

  let msg: Anthropic.Message;
  try {
    msg = _createForTests
      ? await _createForTests(body)
      : await getAnthropicClient().messages.create(body);
  } catch (err) {
    throw new Error(sanitizeAnthropicError(err));
  }

  const text = (msg.content ?? [])
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  if (!text) {
    // A response with no text blocks (e.g. max_tokens=0 edge / tool-only) is
    // a caller bug or upstream anomaly — surface it rather than returning "".
    logger.warn(
      { model, stopReason: msg.stop_reason ?? null },
      "claudeGenerate: response with no text blocks",
    );
  }

  return {
    text,
    model: msg.model ?? model,
    stopReason: msg.stop_reason ?? null,
    usage: {
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0,
    },
  };
}

/**
 * Streaming generation — yields text deltas as they arrive. Powers the
 * chat fast-lane when a Claude model is picked (the compat adapter wraps
 * each delta into the Gemini stream-chunk shape `generateContentStreamText`
 * reads). Errors are sanitized like `claudeGenerate`. (MONEY-626 router.)
 */
export async function* claudeStreamText(
  params: ClaudeGenerateParams,
): AsyncGenerator<string, void, unknown> {
  if (_streamForTests) {
    yield* _streamForTests(params);
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const model = params.model ?? CLAUDE_SONNET_ID;
  const body: Anthropic.MessageCreateParamsStreaming = {
    model,
    max_tokens: params.maxOutputTokens ?? 8192,
    stream: true,
    messages: [{ role: "user", content: params.prompt }],
    ...(params.temperature !== undefined && modelSupportsTemperature(model)
      ? { temperature: params.temperature }
      : {}),
    ...(params.system ? { system: params.system } : {}),
  };

  try {
    const stream = await getAnthropicClient().messages.create(body);
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        event.delta.text
      ) {
        yield event.delta.text;
      }
    }
  } catch (err) {
    throw new Error(sanitizeAnthropicError(err));
  }
}
