/**
 * LLM Observability probe — the child process of `llmobs-wired.test.ts`.
 *
 * It makes ONE LLM SDK call against a stubbed transport and asks dd-trace to
 * flush. The parent owns a local HTTP server standing in for the Datadog Agent
 * and asserts on the LLMObs spans that actually arrive, so the whole path is
 * exercised — auto-instrumentation, the tagger, the span processor and the
 * writer — with zero network and no Datadog credentials.
 *
 * ## Why a separate process at all
 *
 * dd-trace patches ESM through `import-in-the-middle`, which is registered by
 * `--import dd-trace/register.js` and CANNOT be installed after the process has
 * started. Whether that flag is present is precisely the property under test
 * (`workers/Dockerfile` carries it; adding it is MONEY-1380's A3), so the only
 * way to observe both states is to spawn the process twice.
 *
 * ## The transport is stubbed, the instrumentation is not
 *
 * dd-trace wraps the exported `GoogleGenAI` CLASS and patches `models.*` on each
 * instance it constructs, so the span is produced by the wrapper regardless of
 * what the HTTP layer does. The canned bodies below exist to make the call
 * SUCCEED, because the interesting assertions are on a successful span's token
 * metrics — an errored span carries none.
 *
 * `@google/genai` resolves `fetch` from the global lazily, at client
 * construction (`typeof fetch !== 'undefined' ? fetch : throw`), so assigning
 * `globalThis.fetch` before `new GoogleGenAI()` is enough. `@anthropic-ai/sdk`
 * takes a `fetch` option directly, which is used instead — same idea, narrower
 * blast radius.
 *
 * Env contract, set by the parent: PROBE_PROVIDER (genai|anthropic),
 * PROBE_MODE (bare|wrapped), DD_TRACE_AGENT_URL, DD_LLMOBS_* .
 */

import tracer from "dd-trace";

// `agentlessEnabled` is EXPLICITLY false, which is what production does too and
// is not merely a test convenience.
//
// `setAgentStrategy` (dd-trace/src/llmobs/writers/util.js) returns immediately
// when this value is non-null. Left undefined it instead probes the agent's
// /info endpoint, and on ANY error from that probe it flips to agentless and
// `llmobs/index.js:69` THROWS "Cannot send LLM Observability data without a
// running agent or without both a Datadog API key and site" — from inside an
// async callback, so nothing catches it. Stating the strategy removes a
// boot-time race against the sidecar entirely. See `tracerConfig` in
// ../../src/tracer.ts, which resolves it the same way for the same reason.
tracer.init({
  service: "probe",
  profiling: false,
  runtimeMetrics: false,
  llmobs: {
    mlApp: process.env.DD_LLMOBS_ML_APP,
    agentlessEnabled: false,
  },
});

const PROVIDER = process.env.PROBE_PROVIDER ?? "genai";
const MODE = process.env.PROBE_MODE ?? "bare";

/** Minimal successful `generateContent` body, with the usage block that becomes `metrics`. */
const GEMINI_BODY = {
  candidates: [
    { content: { parts: [{ text: "ok" }], role: "model" }, finishReason: "STOP" },
  ],
  usageMetadata: {
    promptTokenCount: 11,
    candidatesTokenCount: 7,
    totalTokenCount: 18,
  },
  modelVersion: "gemini-3-flash-preview",
};

/** Minimal successful `messages.create` body. */
const ANTHROPIC_BODY = {
  id: "msg_probe",
  type: "message",
  role: "assistant",
  model: "claude-opus-5",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 11, output_tokens: 7 },
};

function cannedFetch(body) {
  return async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

async function buildCall() {
  if (PROVIDER === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({
      apiKey: "probe-key",
      fetch: cannedFetch(ANTHROPIC_BODY),
      maxRetries: 0,
    });
    return () =>
      client.messages.create({
        model: "claude-opus-5",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      });
  }

  globalThis.fetch = cannedFetch(GEMINI_BODY);
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({ apiKey: "probe-key" });
  return () =>
    ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: "hi",
    });
}

const call = await buildCall();

if (MODE === "wrapped") {
  // Mirrors `llmWorkflow()` from ../../src/llmobs.ts. The assertion this
  // enables is that the auto-instrumented LLM span INHERITS `ml_app` from this
  // workflow parent rather than falling back to the service name.
  await tracer.llmobs.trace(
    { kind: "workflow", name: "probe-workflow", mlApp: "research" },
    call,
  );
} else {
  await call();
}

tracer.llmobs.flush();

// `flush()` publishes on a diagnostics channel and returns immediately — it is
// fire-and-forget with no promise to await (dd-trace/src/llmobs/sdk.js). The
// writer posts on its own turn of the loop, so the process must stay alive long
// enough for that to happen. This is the same property that makes a Vercel
// `after(() => flush())` unreliable, and why MONEY-1380 measures before adding
// one.
await new Promise((resolve) => setTimeout(resolve, 1500));
process.exit(0);
