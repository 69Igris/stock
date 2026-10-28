/**
 * MONEY-1380 — the deployed shape of LLM Observability, pinned.
 *
 * `llmobs-wired.test.ts` proves the tracer produces spans. This file proves the
 * two things that decide whether it ever runs in production, neither of which a
 * runtime test can see:
 *
 *   1. `workers/Dockerfile` starts node with the ESM loader hook.
 *   2. `DD_LLMOBS_ENABLED` is PRESENT in both Cloud Build specs, on the one
 *      container that makes model calls and no other.
 *
 * ## Present-and-explicit, in both environments
 *
 * "Absent" and "set to off" must not be the same state. That is how
 * MF_METADATA_PROVIDER disabled its job silently for months (MONEY-1214), and
 * the same discipline is already applied to XBRL_PROJECTION_APPLY,
 * DATABENTO_*_APPLY and the EDGAR flags. `INTENDED_FLAG_STATE` below states the
 * value for each environment so a silent DISARM fails this suite too — not just
 * a silent arm.
 *
 * ## Why DD_LLMOBS_ML_APP is deliberately NOT here
 *
 * Two reasons, and the first is a hard limit. `workers/cloudbuild-arg-limit`
 * measures the longest inline Cloud Build argument against a 10,000-character
 * ceiling with a 700-character warning floor; after DD_LLMOBS_ENABLED the prod
 * spec has roughly 40 characters of slack, which is less than one more env
 * entry. Second, `ml_app` is a per-FEATURE value and a container hosts many
 * features — it belongs on the `llmWorkflow()` call, not on the process. The
 * service name is the fallback bucket for anything unwrapped.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SPECS = ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"] as const;

/**
 * The value DD_LLMOBS_ENABLED must carry, per environment.
 *
 * Both are "1": QA is where the spans are observed first, and prod ships armed
 * because a feature behind an off switch is a feature that does not exist —
 * nothing exercises its write path and no monitor has a series to watch. That
 * is the posture MONEY-980 (Tiingo) and MONEY-979 (EDGAR ingest) shipped with.
 */
const INTENDED_FLAG_STATE: Record<(typeof SPECS)[number], string> = {
  "cloudbuild.prod.yaml": "1",
  "cloudbuild.qa.yaml": "1",
};

const readSpec = (spec: string) =>
  readFileSync(join(ROOT, "workers", spec), "utf8");

/**
 * The text of one container's block, from its `- name: <container>` line to the
 * next container declaration at the same indent (or the end of the file).
 *
 * The specs embed Knative YAML inside shell heredocs inside Cloud Build YAML,
 * so a real YAML parse would have to unwrap two layers. Slicing on the
 * declaration is enough to answer "is this variable on THIS container", which
 * is the only question here.
 */
function containerBlock(spec: string, container: string): string {
  const text = readSpec(spec);
  const lines = text.split("\n");
  const declaration = new RegExp(`^\\s*- name: ${container}$`);
  const anyContainer =
    /^\s*- name: (stockbook-workers|tiingo-realtime|datadog-agent)$/;

  const start = lines.findIndex((l) => declaration.test(l));
  assert.notEqual(
    start,
    -1,
    `${spec}: no container declared as \`- name: ${container}\``,
  );

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (anyContainer.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The value of `- name: KEY` / `value: "..."` inside a block, or undefined. */
function envValue(block: string, key: string): string | undefined {
  const m = block.match(
    new RegExp(`- name: ${key}\\s*\\n\\s*value: "?([^"\\n]*)"?`),
  );
  return m?.[1];
}

describe("MONEY-1380 — DD_LLMOBS_ENABLED ships present and explicit", () => {
  for (const spec of SPECS) {
    it(`${spec}: present on stockbook-workers at its intended value`, () => {
      const block = containerBlock(spec, "stockbook-workers");
      const value = envValue(block, "DD_LLMOBS_ENABLED");

      assert.ok(
        value !== undefined,
        `${spec}: DD_LLMOBS_ENABLED is ABSENT from the stockbook-workers ` +
          `container. Absent and explicitly-off must not be the same state ` +
          `(MONEY-1214) — add it with its intended value rather than removing it.`,
      );
      assert.equal(
        value,
        INTENDED_FLAG_STATE[spec],
        `${spec}: DD_LLMOBS_ENABLED is "${value}", intended ` +
          `"${INTENDED_FLAG_STATE[spec]}". A silent disarm fails here too.`,
      );
    });

    it(`${spec}: ABSENT from tiingo-realtime — it makes no model call`, () => {
      // That service is a singleton websocket loop with
      // `cpu-throttling: "false"`, kept deliberately lean (MONEY-1357). Arming
      // LLM Obs there would add a writer and a span processor to an event loop
      // we pay to keep free, for a process that has nothing to instrument.
      const block = containerBlock(spec, "tiingo-realtime");
      assert.equal(
        envValue(block, "DD_LLMOBS_ENABLED"),
        undefined,
        `${spec}: tiingo-realtime must not carry DD_LLMOBS_ENABLED`,
      );
    });

    it(`${spec}: DD_LLMOBS_ML_APP appears nowhere`, () => {
      // A per-feature value on a per-process switch would be wrong even if it
      // fit, and it does not fit: see the header note on the arg-length ceiling.
      assert.ok(
        !readSpec(spec).includes("DD_LLMOBS_ML_APP"),
        `${spec}: ml_app belongs on the llmWorkflow() call, not the container`,
      );
    });
  }
});

describe("MONEY-1380 — the ESM loader hook is on the service entrypoint", () => {
  const dockerfile = readFileSync(join(ROOT, "workers", "Dockerfile"), "utf8");
  const cmd = dockerfile
    .split("\n")
    .filter((l) => l.startsWith("CMD ["))
    .at(-1);

  it("CMD starts node with --import dd-trace/register.js", () => {
    // Without it, dd-trace cannot patch this bundle's ESM imports and every
    // model call is invisible. Proved end-to-end by llmobs-wired.test.ts, whose
    // mutation case runs the same probe without the flag and gets zero spans.
    assert.ok(cmd, "no CMD [...] line in workers/Dockerfile");
    assert.match(cmd, /--import/, "CMD does not pass --import");
    assert.match(
      cmd,
      /dd-trace\/register\.js/,
      "CMD does not register dd-trace's loader hook",
    );
  });

  it("uses register.js, NOT initialize.mjs", () => {
    // `initialize.mjs` installs the loader AND calls tracer.init() from the
    // environment. That second half would construct a tracer before
    // `initTracer` runs, overriding the options resolved in code — profiling
    // and runtimeMetrics among them, which MONEY-1357 turns off for a reason.
    assert.ok(
      !cmd!.includes("initialize.mjs"),
      "initialize.mjs also inits the tracer from env and overrides tracerConfig",
    );
  });

  it("the flag is NOT on the tiingo-realtime command override", () => {
    for (const spec of SPECS) {
      const block = containerBlock(spec, "tiingo-realtime");
      const command = block.match(/command: \[[^\]]*\]/)?.[0];
      assert.ok(command, `${spec}: tiingo-realtime has no command: override`);
      assert.ok(
        !command.includes("dd-trace/register.js"),
        `${spec}: tiingo-realtime must not load the tracer hook — it makes no ` +
          `model call and the loop is kept lean on purpose`,
      );
    }
  });
});

/**
 * ── The Vercel side ─────────────────────────────────────────────────────────
 *
 * Three properties, each of which independently reduces LLM Obs on Vercel to
 * silence, and none of which produces an error when wrong.
 */
describe("MONEY-1380 — Vercel: the LLM SDKs stay outside the bundle", () => {
  const nextConfig = readFileSync(
    join(ROOT, "apps", "web", "next.config.js"),
    "utf8",
  );

  for (const pkg of ["@google/genai", "@anthropic-ai/sdk"]) {
    it(`serverExternalPackages lists ${pkg}`, () => {
      // dd-trace instruments by intercepting the module loader. A package
      // webpack has inlined into the server bundle is never `require`d, so the
      // hook never fires — the call is simply untraced, with no error anywhere.
      assert.ok(
        new RegExp(
          `serverExternalPackages[\\s\\S]*"${pkg.replace("/", "\\/")}"`,
        ).test(nextConfig),
        `apps/web/next.config.js must externalize ${pkg}, or dd-trace cannot ` +
          `instrument it and every model call from a route or server action ` +
          `is invisible`,
      );
    });
  }
});

describe("MONEY-1380 — Vercel: the tracer is initialised, without a profiler", () => {
  const instrumentation = readFileSync(
    join(ROOT, "apps", "web", "instrumentation.ts"),
    "utf8",
  );
  const apiTracer = readFileSync(
    join(ROOT, "apps", "api", "src", "tracer.ts"),
    "utf8",
  );
  const apiApp = readFileSync(
    join(ROOT, "apps", "api", "src", "app.ts"),
    "utf8",
  );

  for (const [name, src] of [
    ["apps/web/instrumentation.ts", instrumentation],
    ["apps/api/src/tracer.ts", apiTracer],
  ] as const) {
    it(`${name} passes profiling:false and runtimeMetrics:false`, () => {
      // `tracerConfig` DEFAULTS both to true and an explicit option beats the
      // environment, so no DD_ var in a Vercel project setting can turn them
      // off. There is no agent to receive a pprof upload.
      assert.match(src, /profiling:\s*false/, `${name}: profiling must be off`);
      assert.match(
        src,
        /runtimeMetrics:\s*false/,
        `${name}: runtimeMetrics must be off`,
      );
    });
  }

  it("apps/api/src/app.ts imports the tracer, and imports it FIRST", () => {
    // The Vercel entry point (api/[[...route]].ts) imports ../dist/app.js and
    // never src/index.ts, where the original initTracer call lives — so
    // stockbook-api had no tracer in production at all. ESM evaluates imports
    // in source order, so this one has to precede everything it should patch.
    const lines = apiApp.split("\n");
    const tracerLine = lines.findIndex((l) =>
      /^import ["']\.\/tracer["']/.test(l),
    );
    assert.notEqual(
      tracerLine,
      -1,
      'apps/api/src/app.ts must `import "./tracer";` — the Vercel entry point ' +
        "never loads src/index.ts",
    );

    const firstOtherImport = lines.findIndex(
      (l, i) => i !== tracerLine && /^import /.test(l),
    );
    assert.ok(
      tracerLine < firstOtherImport,
      "the tracer import must come before every other import in app.ts",
    );
  });
});
