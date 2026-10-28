/**
 * MONEY-1380 — LLM Observability is WIRED, proved against a real tracer.
 *
 * ## What this exists to catch
 *
 * Every other guard in this repo for LLM Obs is a source or spec scan: they
 * prove a call site exists, or an env var is present in a Cloud Build spec.
 * None of them can prove the tracer actually PRODUCES a span, and that is the
 * half that silently does not work here.
 *
 * `workers` is an ESM bundle (`tsup` → `format: ["esm"]`) with the LLM SDKs
 * left external, so `workers/dist/index.js` carries real `import` statements
 * for `@google/genai` and `@anthropic-ai/sdk`. dd-trace patches CommonJS with
 * `require-in-the-middle`, which needs nothing, but patches ESM with
 * `import-in-the-middle`, which must be registered by
 * `--import dd-trace/register.js` BEFORE the process loads anything. Without
 * that flag every LLM call in the workers image is invisible — and invisible
 * here renders as an empty LLM Observability page, which is indistinguishable
 * from a product nobody used.
 *
 * The estate carried the fingerprint of exactly this: until the flag shipped,
 * the only server span ever observed live for `stockbook-workers` was
 * `web.request`, which comes from core `http` via diagnostics_channel and
 * needs no loader, and `apply-service-monitors.sh` recorded our Gemini calls
 * arriving as OUTBOUND `http.request` — the transport, never the model call.
 * Once it shipped (~2026-09-11) the span became `hono.request`: dd-trace's
 * Hono plugin, which patches only through the loader, renamed it. That is the
 * loader working in production — and it is MONEY-1534, because every monitor
 * that spelled `web.request` went dark.
 *
 * So the mutation case below is the point of the file: the same probe, with the
 * flag removed, must produce ZERO spans. If that case ever goes green, the
 * suite is no longer measuring anything.
 *
 * ## How it works
 *
 * A local HTTP server stands in for the Datadog Agent. dd-trace's agent-mode
 * LLMObs writer POSTs to `<agent>/evp_proxy/v2/api/v2/llmobs`
 * (`llmobs/constants/writers.js`), so the server records those bodies and the
 * assertions read the spans Datadog would have received. No network, no
 * credentials, no Datadog account.
 *
 * The payload is an ARRAY of `{ event_type, spans[] }` envelopes — one per
 * finished span, not one batch object — which is why `collectSpans` flattens
 * rather than indexing.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, "fixtures", "llmobs-probe.mjs");
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");

/** One LLMObs span as it arrives on the wire. */
interface LlmObsSpan {
  name?: string;
  tags?: string[];
  status?: string;
  meta?: {
    "span.kind"?: string;
    model_name?: string;
    model_provider?: string;
    input?: { messages?: { role?: string; content?: string }[] };
    output?: { messages?: { role?: string; content?: string }[] };
  };
  metrics?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

interface ProbeResult {
  exitCode: number | null;
  spans: LlmObsSpan[];
  output: string;
}

/**
 * A stand-in Datadog Agent, reused across every case so the suite pays for one
 * listener rather than one per spawn.
 *
 * `/info` advertises the EVP proxy because that is what a real agent does. The
 * probe states its strategy explicitly so this is never consulted, but serving
 * it wrong would turn a future probe-mode run into a confusing agentless throw
 * rather than a clean failure.
 */
class FakeAgent {
  readonly #server: http.Server;
  #bodies: unknown[] = [];

  private constructor(server: http.Server) {
    this.#server = server;
  }

  static async start(): Promise<FakeAgent> {
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.url?.includes("/api/v2/llmobs")) {
          try {
            bodies.push(JSON.parse(raw));
          } catch {
            // A body we cannot parse is a failure the assertions should show as
            // "no spans", not as an exception inside the server.
          }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          req.url?.startsWith("/info")
            ? JSON.stringify({ endpoints: ["/evp_proxy/v2/"] })
            : "{}",
        );
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const agent = new FakeAgent(server);
    agent.#bodies = bodies;
    return agent;
  }

  get url(): string {
    const addr = this.#server.address();
    if (addr === null || typeof addr === "string") {
      throw new Error("fake agent is not listening on a TCP port");
    }
    return `http://127.0.0.1:${addr.port}`;
  }

  reset(): void {
    this.#bodies.length = 0;
  }

  collectSpans(): LlmObsSpan[] {
    return this.#bodies.flatMap((body) =>
      Array.isArray(body)
        ? body.flatMap(
            (envelope: { spans?: LlmObsSpan[] }) => envelope?.spans ?? [],
          )
        : ((body as { spans?: LlmObsSpan[] })?.spans ?? []),
    );
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

let agent: FakeAgent;

before(async () => {
  agent = await FakeAgent.start();
});

after(async () => {
  await agent?.stop();
});

/**
 * Run the probe once and return the spans that reached the fake agent.
 *
 * `loader: false` is the mutation: the SAME probe, minus
 * `--import dd-trace/register.js`.
 */
async function runProbe(opts: {
  provider: "genai" | "anthropic";
  mode: "bare" | "wrapped";
  loader: boolean;
}): Promise<ProbeResult> {
  agent.reset();

  const args = opts.loader
    ? ["--import", "dd-trace/register.js", PROBE]
    : [PROBE];

  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PROBE_PROVIDER: opts.provider,
      PROBE_MODE: opts.mode,
      DD_TRACE_ENABLED: "true",
      DD_LLMOBS_ENABLED: "1",
      DD_LLMOBS_ML_APP: "probe",
      DD_TRACE_AGENT_URL: agent.url,
      // Keep the child from reaching for anything but our fake agent: without
      // these it opens telemetry, remote-config and profiler connections whose
      // failures are noise in the assertion output.
      DD_TRACE_STARTUP_LOGS: "false",
      DD_INSTRUMENTATION_TELEMETRY_ENABLED: "false",
      DD_REMOTE_CONFIG_ENABLED: "false",
      DD_PROFILING_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));

  // A probe that hangs must fail this suite, never outlive it: an orphaned
  // child holding a socket is the shape that turns one bad case into a dead
  // CI task with no failing assertion.
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exitCode = await new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  clearTimeout(timer);

  // Let the last POST land: `exit` fires when the process dies, which can beat
  // the server's `end` handler for a request already in flight.
  await new Promise((resolve) => setTimeout(resolve, 150));

  return { exitCode, spans: agent.collectSpans(), output };
}

const llmSpans = (spans: LlmObsSpan[]) =>
  spans.filter((s) => s.meta?.["span.kind"] === "llm");

describe("MONEY-1380 — LLM Obs emits real spans for @google/genai", () => {
  it("produces an llm span carrying model, provider and REAL token counts", async () => {
    const { exitCode, spans, output } = await runProbe({
      provider: "genai",
      mode: "bare",
      loader: true,
    });

    assert.equal(exitCode, 0, `probe failed:\n${output}`);

    const llm = llmSpans(spans);
    assert.equal(
      llm.length,
      1,
      `expected exactly one llm span, got ${llm.length}:\n${output}`,
    );

    const span = llm[0]!;
    assert.equal(span.meta?.model_name, "gemini-3-flash-preview");
    assert.equal(span.meta?.model_provider, "google");
    assert.equal(span.status, "ok");

    // The whole point of LLM Obs over a hand-rolled counter: the token numbers
    // come off the vendor's own usage block. `packages/research` bills from a
    // `text.length / 4` heuristic instead, which is a separate ticket, but it
    // is why "did a REAL token count arrive" is the assertion worth making.
    assert.equal(span.metrics?.input_tokens, 11);
    assert.equal(span.metrics?.output_tokens, 7);
  });

  it("defaults ml_app to DD_LLMOBS_ML_APP when nothing wraps the call", async () => {
    const { spans } = await runProbe({
      provider: "genai",
      mode: "bare",
      loader: true,
    });

    const span = llmSpans(spans)[0];
    assert.ok(span, "no llm span to read ml_app from");
    assert.ok(
      span.tags?.includes("ml_app:probe"),
      `expected ml_app:probe, tags were ${JSON.stringify(span.tags)}`,
    );
  });

  it("MUTATION: without --import dd-trace/register.js there are NO spans at all", async () => {
    // The load-bearing case. ESM imports cannot be patched by a tracer that was
    // never given the loader hook, so removing the flag must remove the
    // telemetry entirely — not degrade it.
    //
    // If this ever goes green while the case above also passes, either the SDK
    // has moved to CommonJS resolution or dd-trace has changed how it patches,
    // and `workers/Dockerfile`'s flag should be re-justified before anyone
    // trusts the rest of this file.
    const { exitCode, spans, output } = await runProbe({
      provider: "genai",
      mode: "bare",
      loader: false,
    });

    assert.equal(exitCode, 0, `probe failed:\n${output}`);
    assert.equal(
      llmSpans(spans).length,
      0,
      "an llm span arrived WITHOUT the ESM loader — the --import flag in " +
        "workers/Dockerfile may no longer be what makes instrumentation work",
    );
  });
});

describe("MONEY-1380 — ml_app is inherited, so one wrapper covers a whole feature", () => {
  it("an auto-instrumented llm span takes ml_app from its workflow parent", async () => {
    // This is what makes `llmWorkflow()` cheap: eight wrapped entry points,
    // rather than a tag threaded through every call site in `packages/research`.
    // dd-trace resolves `ml_app` as
    //   explicit ‖ parent span's ‖ propagated tag ‖ config ‖ service
    // (llmobs/tagger.js), so the child inherits without being told.
    const { exitCode, spans, output } = await runProbe({
      provider: "genai",
      mode: "wrapped",
      loader: true,
    });

    assert.equal(exitCode, 0, `probe failed:\n${output}`);

    const llm = llmSpans(spans)[0];
    assert.ok(llm, `no llm span:\n${output}`);
    assert.ok(
      llm.tags?.includes("ml_app:research"),
      `llm child did not inherit ml_app:research — tags ${JSON.stringify(llm.tags)}`,
    );

    // And the parent is there too, so a feature shows up as one workflow with
    // its model calls underneath rather than a flat list of llm spans.
    const workflow = spans.find((s) => s.meta?.["span.kind"] === "workflow");
    assert.ok(workflow, "the workflow parent span never arrived");
    assert.ok(workflow.tags?.includes("ml_app:research"));
  });
});

describe("MONEY-1380 — the Claude router is instrumented too", () => {
  it("@anthropic-ai/sdk produces an llm span tagged model_provider:anthropic", async () => {
    // `packages/core/src/anthropic/client.ts` is the founder-gated Claude
    // router. It is the most expensive path in the product and the one whose
    // rationing (CLAUDE_ALLOWED_EMAILS, creditPremium 4) has never had a
    // measurement behind it.
    const { exitCode, spans, output } = await runProbe({
      provider: "anthropic",
      mode: "bare",
      loader: true,
    });

    assert.equal(exitCode, 0, `probe failed:\n${output}`);

    const llm = llmSpans(spans);
    assert.equal(llm.length, 1, `expected one llm span:\n${output}`);
    assert.equal(llm[0]!.meta?.model_provider, "anthropic");
    assert.equal(llm[0]!.meta?.model_name, "claude-opus-5");
    assert.equal(llm[0]!.metrics?.input_tokens, 11);
    assert.equal(llm[0]!.metrics?.output_tokens, 7);
  });
});

describe("MONEY-1380 — what LLM Obs captures, stated as a test", () => {
  it("prompt AND completion text are on the span by default", async () => {
    // Not a nice-to-have assertion: the JS SDK exposes NO capture toggle and no
    // span character limit (the only keys it parses are DD_LLMOBS_ENABLED,
    // DD_LLMOBS_ML_APP and DD_LLMOBS_AGENTLESS_ENABLED), so enabling LLM Obs
    // sends user-visible text to Datadog and there is no env var that stops it.
    //
    // For this product that text can contain portfolio holdings. The decision
    // taken in MONEY-1380 is to allow it and scrub Datadog-side with a
    // Sensitive Data Scanner rule; this test is here so that decision cannot be
    // forgotten silently — if a future dd-trace redacts by default, this fails
    // and someone re-reads the policy on purpose.
    const { spans } = await runProbe({
      provider: "genai",
      mode: "bare",
      loader: true,
    });

    const span = llmSpans(spans)[0];
    assert.ok(span, "no llm span");
    assert.equal(span.meta?.input?.messages?.[0]?.content, "hi");
    assert.equal(span.meta?.output?.messages?.[0]?.content, "ok");
  });
});
