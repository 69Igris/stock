/**
 * MONEY-1380 — every worker that reaches a model carries an `ml_app`.
 *
 * ## Why this is a scan AND why a scan is not enough on its own
 *
 * `llmobs-wired.test.ts` proves the MECHANISM: that `llmWorkflow()` produces a
 * workflow span and that auto-instrumented LLM children inherit its `ml_app`.
 * It cannot prove COVERAGE — that the mechanism is applied at every entry point
 * that needs it. This file is the other half, and neither is sufficient alone
 * (MONEY-1309: a budget guard wired at one of five call sites under-reported
 * spend by ~80%, which is worse than no guard because it manufactures headroom).
 *
 * ## The explicit list is not the whole rule
 *
 * A named list of files is precise and silently shrinks: the next processor to
 * call a model is simply not on it, and nothing fails. So there are two rules
 * here, and the second is the load-bearing one —
 *
 *   1. every file in EXPECTED_WRAPS is wrapped with the `ml_app` intended;
 *   2. every processor that REACHES A MODEL is in EXPECTED_WRAPS.
 *
 * Rule 2 earned its place immediately: it caught `login-briefing.ts` and
 * `preview-plan.ts`, which both call `generateWithTimeout` and were missing
 * from the hand-written plan this ticket started from.
 *
 * ## What "unwrapped" costs, so the rule is not over-applied
 *
 * An unwrapped model call is NOT dropped. `ml_app` falls back to the service
 * name (`stockbook-workers`), which is a visible "not yet attributed" bucket.
 * So this rule exists to keep the ATTRIBUTION honest, not to prevent data loss —
 * which is why `*-logic.ts` modules are excluded (pure helpers called by a
 * processor that is itself wrapped; the span is already open above them) and why
 * the long tail of small web actions is deliberately left unwrapped for now.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PROCESSORS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "workers",
  "src",
  "processors",
);

/**
 * The intended `ml_app` for every worker entry point that reaches a model.
 *
 * The values are a FEATURE vocabulary, not a service or package one: `research`
 * covers three different processors because they are one thing to the person
 * paying for them. Renaming a value splits that feature's history in the LLM
 * Obs UI at the rename, so these are chosen once and left alone.
 */
const EXPECTED_WRAPS: Record<string, string> = {
  "research.ts": "research",
  "comparison.ts": "research",
  "preview-plan.ts": "research",
  "l3-analysis.ts": "analysis",
  "roast.ts": "roast",
  "login-briefing.ts": "briefing",
  "stock-document-ingest.ts": "doc-ingest",
  "stock-document-parse.ts": "doc-ingest",
  "studio-render.ts": "video",
};

/**
 * Evidence that a processor reaches a model.
 *
 * These are the CALL/IMPORT symbols, not package names, because a package can
 * be imported for pure helpers: `strategy-scan.ts` imports `executeStrategy`
 * from `@usemoney/research` and runs a backtest with no model in it, and
 * `ownership-sync.ts` imports that package's data-source scrapers. Matching on
 * `@usemoney/research` would drag both in and the rule would be quietly
 * disabled by whoever had to make them pass.
 */
const MODEL_REACHING = [
  /generateWithTimeout/, // @usemoney/core/gemini
  /new ResearchAgent/, // the multi-skill agent
  /from "\.\.\/lib\/gemini-pdf"/, // document reading (Gemini vision)
  /@usemoney\/roast/, // the roast engine
  /@usemoney\/video-studio/, // Veo generation
  /new Anthropic/, // the Claude router
];

const processorFiles = () =>
  readdirSync(PROCESSORS)
    .filter((f) => f.endsWith(".ts"))
    // Pure helper modules. Their caller is the wrapped entry point, so the
    // workflow span is already open by the time they run.
    .filter((f) => !f.endsWith("-logic.ts"));

const read = (file: string) => readFileSync(join(PROCESSORS, file), "utf8");

describe("MONEY-1380 — the named entry points are wrapped", () => {
  for (const [file, mlApp] of Object.entries(EXPECTED_WRAPS)) {
    it(`${file} tags its model calls ml_app:${mlApp}`, () => {
      const src = read(file);
      assert.match(
        src,
        /llmWorkflow\(/,
        `${file} makes model calls but does not call llmWorkflow()`,
      );
      assert.match(
        src,
        new RegExp(`llmWorkflow\\(\\s*"${mlApp}"`),
        `${file} should pass ml_app "${mlApp}"`,
      );
    });
  }

  it("imports llmWorkflow from the SUBPATH, never the root barrel", () => {
    // Standing repo rule. The root barrel pulls the metrics and job-outcome
    // modules in with it, and `@usemoney/datadog` root is a heavier import than
    // a worker entry point needs.
    for (const file of Object.keys(EXPECTED_WRAPS)) {
      const src = read(file);
      assert.ok(
        src.includes('from "@usemoney/datadog/llmobs"'),
        `${file} must import from @usemoney/datadog/llmobs`,
      );
    }
  });
});

describe("MONEY-1380 — CATCH-ALL: no model-reaching processor is unattributed", () => {
  it("every processor that reaches a model is in EXPECTED_WRAPS", () => {
    const reaching = processorFiles().filter((f) => {
      const src = read(f);
      return MODEL_REACHING.some((re) => re.test(src));
    });

    const missing = reaching.filter((f) => !(f in EXPECTED_WRAPS));

    assert.deepEqual(
      missing,
      [],
      `These processors reach a model but have no ml_app, so their spend lands ` +
        `in the unattributed "stockbook-workers" bucket: ${missing.join(", ")}. ` +
        `Add each to EXPECTED_WRAPS with the feature it belongs to and wrap its ` +
        `entry point with llmWorkflow().`,
    );
  });

  it("PREMISE: the detector actually finds the population it claims to", () => {
    // A catch-all whose detector matches nothing passes forever while checking
    // nothing — the MONEY-1238 shape. Pin the count so a regex that stops
    // matching (a renamed helper, a moved import path) fails LOUDLY here rather
    // than silently disarming the rule above.
    const reaching = processorFiles().filter((f) =>
      MODEL_REACHING.some((re) => re.test(read(f))),
    );
    assert.equal(
      reaching.length,
      Object.keys(EXPECTED_WRAPS).length,
      `the detector found ${reaching.length} model-reaching processors but ` +
        `EXPECTED_WRAPS names ${Object.keys(EXPECTED_WRAPS).length}. If a ` +
        `processor was legitimately added or removed, update both; if the ` +
        `numbers drifted without that, a MODEL_REACHING pattern has gone stale.`,
    );
  });

  it("every EXPECTED_WRAPS entry still exists on disk", () => {
    // A renamed or deleted processor would otherwise leave a row asserting
    // against a file nobody has, and `read()` would throw an ENOENT that reads
    // like a broken test rather than a stale list.
    const present = new Set(processorFiles());
    for (const file of Object.keys(EXPECTED_WRAPS)) {
      assert.ok(
        present.has(file),
        `${file} is in EXPECTED_WRAPS but not on disk`,
      );
    }
  });
});

/**
 * ── The Vercel side ─────────────────────────────────────────────────────────
 *
 * Same two rules, one deliberate difference: there is no pure catch-all,
 * because MONEY-1380 decided to leave a TAIL of small server actions
 * unattributed until observed spend says which of them deserve their own row.
 *
 * So the tail is NAMED instead. A file may be unwrapped, but it may not be
 * unwrapped ANONYMOUSLY — adding a new model-reaching action fails this suite
 * until somebody either wraps it or writes it into the tail on purpose. That
 * keeps the shrink-silently property out without pretending the tail is a bug.
 */

const WEB_ROOT = join(import.meta.dirname, "..", "..", "..", "apps", "web");

/** Wrapped Vercel entry points and their intended ml_app. */
const VERCEL_WRAPS: Record<string, string> = {
  "app/api/chat/route.ts": "chat",
  "app/api/screener-chat/route.ts": "chat",
  "app/api/research/preview-plan/route.ts": "research",
  "lib/actions/fire-chat.ts": "fire",
};

/**
 * Model-reaching web files deliberately left on the service-name bucket
 * (`stockbook-web`). Each is a small, single-shot generation; none is a
 * multi-call agent run, which is what makes the attribution worth paying for.
 * Phase 2 promotes whichever of these the observed spend says matters.
 */
const KNOWN_UNWRAPPED_TAIL = [
  // Single-shot filter generation behind a screener modal. Reached as a server
  // action straight from the client, so — unlike the helpers under a wrapped
  // route — it has no parent span to inherit from.
  "lib/actions/ai-filter-builder.ts",
  "lib/actions/mf-description.ts",
  "lib/actions/news.ts",
  "lib/actions/quiz.ts",
  "lib/actions/stock-description.ts",
  "lib/actions/strategy.ts",
];

/**
 * Evidence that a web route or server action reaches a model.
 *
 * `\.generateContent\(` and `getGeminiClient` are here because the FIRST
 * version of this list omitted them and missed two real call sites —
 * `app/api/screener-chat/route.ts` (wrapped, but invisible to the rule that was
 * supposed to be guarding it) and `lib/actions/ai-filter-builder.ts` (not
 * wrapped and not in the tail, i.e. exactly the anonymous unattributed entry
 * point this rule exists to prevent). A catch-all is only worth what its
 * detector matches, which is why the PREMISE case below pins the population.
 */
const WEB_MODEL_REACHING =
  /generateWithTimeout|new ResearchAgent|new Anthropic|@usemoney\/roast|runFireChatTurn|getGeminiModel|\.generateContent\(|generateContentStream\(|getGeminiClient/;

/** Every .ts under apps/web/{app/api,lib/actions}, repo-relative to apps/web. */
function webSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(join(WEB_ROOT, dir), {
      withFileTypes: true,
    })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.name.endsWith(".ts") && !rel.includes("__tests__"))
        out.push(rel);
    }
  };
  walk(join("app", "api"), "app/api");
  walk(join("lib", "actions"), "lib/actions");
  return out;
}

describe("MONEY-1380 — Vercel entry points carry an ml_app", () => {
  for (const [file, mlApp] of Object.entries(VERCEL_WRAPS)) {
    it(`${file} tags its model calls ml_app:${mlApp}`, () => {
      const src = readFileSync(join(WEB_ROOT, file), "utf8");
      assert.match(
        src,
        new RegExp(`llmWorkflow\\(\\s*"${mlApp}"`),
        `${file} should wrap its entry point with ml_app "${mlApp}"`,
      );
      assert.ok(
        src.includes('from "@usemoney/datadog/llmobs"'),
        `${file} must import from the @usemoney/datadog/llmobs subpath`,
      );
    });
  }

  it("the unattributed tail is NAMED, so a new one cannot slip in anonymously", () => {
    const reaching = webSourceFiles().filter((f) =>
      WEB_MODEL_REACHING.test(readFileSync(join(WEB_ROOT, f), "utf8")),
    );
    const unwrapped = reaching.filter(
      (f) => !readFileSync(join(WEB_ROOT, f), "utf8").includes("llmWorkflow("),
    );
    const unexpected = unwrapped.filter(
      (f) => !KNOWN_UNWRAPPED_TAIL.includes(f),
    );

    assert.deepEqual(
      unexpected,
      [],
      `These web files reach a model, are not wrapped, and are not in the ` +
        `known tail: ${unexpected.join(", ")}. Either wrap the entry point ` +
        `with llmWorkflow(), or add it to KNOWN_UNWRAPPED_TAIL deliberately — ` +
        `an unwrapped call lands in the "stockbook-web" bucket, which is ` +
        `visible but unattributed.`,
    );
  });

  it("PREMISE: the web detector matches the population it claims to", () => {
    // Without this, a detector that quietly stops matching leaves the rule
    // above passing over an empty set — the MONEY-1238 shape, and the exact
    // failure this list already had once.
    const reaching = webSourceFiles().filter((f) =>
      WEB_MODEL_REACHING.test(readFileSync(join(WEB_ROOT, f), "utf8")),
    );
    const expected =
      Object.keys(VERCEL_WRAPS).length + KNOWN_UNWRAPPED_TAIL.length;
    assert.equal(
      reaching.length,
      expected,
      `the web detector found ${reaching.length} model-reaching files but ` +
        `VERCEL_WRAPS + KNOWN_UNWRAPPED_TAIL name ${expected}. Update both, or ` +
        `a WEB_MODEL_REACHING pattern has gone stale.`,
    );
  });

  it("PREMISE: every named tail entry still reaches a model", () => {
    // A stale tail entry would silently widen the allowance above. If one of
    // these stops calling a model, it should leave the list rather than sit
    // there granting an exemption nothing needs.
    for (const file of KNOWN_UNWRAPPED_TAIL) {
      const src = readFileSync(join(WEB_ROOT, file), "utf8");
      assert.ok(
        WEB_MODEL_REACHING.test(src),
        `${file} no longer reaches a model — remove it from KNOWN_UNWRAPPED_TAIL`,
      );
    }
  });
});

describe("MONEY-1380 — every llmWorkflow wrapper is declared async", () => {
  it("no wrapper is a plain function returning a Promise", () => {
    // This is a BUILD constraint that no type-checker sees. A Next.js
    // `"use server"` module requires every export to be an `async function`;
    // `export function x(): Promise<T>` has an identical type and is rejected
    // at build time with "Server Actions must be async functions". It cost a
    // red build on apps/web during MONEY-1380.
    //
    // Enforced across BOTH apps and the workers so that the wrapper shape
    // someone copies is always the one that builds — the workers' wrappers are
    // not server actions, but they are the nearest example to hand.
    const roots = [
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "workers",
        "src",
        "processors",
      ),
      join(WEB_ROOT, "app", "api"),
      join(WEB_ROOT, "lib", "actions"),
    ];

    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        if (!e.name.endsWith(".ts")) continue;
        const lines = readFileSync(full, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (!/return llmWorkflow\(/.test(line)) return;
          // Walk back to the NEAREST preceding top-level function declaration,
          // with no window.
          //
          // This used to stop after 8 lines, which is a blind spot rather than
          // a bound: a wrapper whose signature runs long — a multi-line
          // parameter list, a generic, a wide return type — matched neither
          // pattern and was silently SKIPPED, so the build-breaking
          // `export function x(): Promise<T>` shape this exists to catch would
          // have passed. The fixtures all happened to be short enough today,
          // which is exactly how a guard rots quietly.
          for (let j = i; j >= 0; j--) {
            const decl = lines[j]!;
            if (/^(export )?async function /.test(decl)) return; // fine
            if (/^export function /.test(decl)) {
              offenders.push(`${full}:${j + 1}`);
              return;
            }
            // A non-exported plain function is not a wrapper we police.
            if (/^function /.test(decl)) return;
          }
          // No declaration found at all — report it rather than pass, so a
          // shape this walk cannot parse becomes visible instead of exempt.
          offenders.push(`${full}:${i + 1} (no enclosing declaration found)`);
        });
      }
    };
    for (const r of roots) walk(r);

    assert.deepEqual(
      offenders,
      [],
      `these llmWorkflow wrappers are not async: ${offenders.join(", ")}`,
    );
  });
});

/**
 * ── Cloud Run JOBS ──────────────────────────────────────────────────────────
 *
 * Jobs are outside every rule above, and that is a real gap rather than a
 * tidy exclusion: `scripts/jobs/*.ts` are bundled entry points launched as
 * `node dist/<job>.js` by their setup scripts, so they inherit NEITHER the
 * service image's `--import dd-trace/register.js` CMD NOR the service's
 * `DD_LLMOBS_ENABLED` (a Cloud Run job does not inherit the service env block).
 *
 * `doc-ingest-backfill.ts` already imports `@google/genai` and constructs a
 * client. It is harmless only because its single SDK use is `batches.*`, which
 * dd-trace's genai plugin does not instrument — so nothing is lost. The moment
 * a job calls `generateContent` / `generateContentStream` / `embedContent` it
 * would produce spans that go nowhere, with no error and no ml_app.
 */
describe("MONEY-1380 — a Cloud Run JOB cannot quietly start making model calls", () => {
  const JOBS = join(import.meta.dirname, "..", "..", "..", "scripts", "jobs");

  /** Methods dd-trace's genai plugin actually wraps. */
  const INSTRUMENTED =
    /\.(generateContent|generateContentStream|embedContent)\s*\(/;

  const jobFiles = () => readdirSync(JOBS).filter((f) => f.endsWith(".ts"));

  it("no job calls an INSTRUMENTED model method", () => {
    const offenders = jobFiles().filter((f) =>
      INSTRUMENTED.test(readFileSync(join(JOBS, f), "utf8")),
    );
    assert.deepEqual(
      offenders,
      [],
      `these Cloud Run jobs call an instrumented model method but run without ` +
        `the ESM loader flag and without DD_LLMOBS_ENABLED, so their spans go ` +
        `nowhere silently: ${offenders.join(", ")}. Either give that job's ` +
        `setup script the loader flag and the env var, or keep it to APIs the ` +
        `plugin does not wrap (batches.*).`,
    );
  });

  it("PREMISE: the scan is looking at real files, one of which uses the SDK", () => {
    // Without this, a moved directory or a renamed job would make the rule
    // above pass over an empty set — the MONEY-1238 shape, which this file has
    // already been bitten by twice.
    const files = jobFiles();
    assert.ok(
      files.length > 5,
      `expected a populated scripts/jobs, saw ${files.length}`,
    );
    assert.ok(
      files.some((f) =>
        /@google\/genai/.test(readFileSync(join(JOBS, f), "utf8")),
      ),
      "no job imports @google/genai — if that is genuinely true now, this " +
        "premise can go, but verify it rather than deleting it",
    );
  });
});

/**
 * ── tiingo-realtime ─────────────────────────────────────────────────────────
 *
 * It is EXCLUDED from LLM Observability today, and that exclusion has an expiry
 * date rather than being permanent — the US market UI is expected to bring
 * model calls with it.
 *
 * Why not simply arm it now: it makes ZERO model calls (re-verified
 * 2026-09-11), so `DD_LLMOBS_ENABLED` there would instrument nothing while
 * adding a span processor and an HTTP writer to a SINGLETON event loop that
 * `run.googleapis.com/cpu-throttling: "false"` exists to keep free. That is the
 * same loop MONEY-1357 turned the profiler and runtime metrics OFF for, having
 * measured ~1,440 pprof cycles a day on it. Arming a service "ready for later"
 * costs something real now and buys nothing until later arrives.
 *
 * So the exclusion is GUARDED instead of documented. The day someone adds a
 * model call here — when the UI lands — this fails, and the arming decision
 * gets made deliberately instead of being discovered as an empty LLM Obs page.
 *
 * To arm it then, three things, none of which should happen before the first
 * model call exists:
 *   1. `DD_LLMOBS_ENABLED=1` on the `tiingo-realtime` container in BOTH specs
 *      (`llmobs-deploy-contract.test.ts` asserts it is ABSENT — flip that too).
 *   2. `--import dd-trace/register.js` on its `command:` override, since it is
 *      the same ESM bundle as the service and the loader is what makes
 *      instrumentation work at all.
 *   3. A `llmWorkflow()` wrapper with an ml_app of its own, and a row here.
 */
describe("MONEY-1380 — tiingo-realtime is excluded, and the exclusion is watched", () => {
  const RT = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "workers",
    "src",
    "realtime",
  );

  const MODEL_CALL =
    /generateWithTimeout|new ResearchAgent|new Anthropic|GoogleGenAI|@usemoney\/roast|@usemoney\/video-studio|\.generateContent\(|\.embedContent\(/;

  it("makes NO model call — the day it does, arm it deliberately", () => {
    const offenders = readdirSync(RT)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => MODEL_CALL.test(readFileSync(join(RT, f), "utf8")));

    assert.deepEqual(
      offenders,
      [],
      `tiingo-realtime now calls a model (${offenders.join(", ")}), but it is ` +
        `excluded from LLM Observability: no DD_LLMOBS_ENABLED on its ` +
        `container and no loader flag on its command override, so those calls ` +
        `produce NOTHING and the page looks like a feature nobody used. Arm ` +
        `it — see the three steps in this suite's doc comment — rather than ` +
        `deleting this case.`,
    );
  });

  it("PREMISE: the directory is real and holds the realtime service", () => {
    // A renamed or moved directory would make the rule above pass over an empty
    // set, which is the MONEY-1238 shape this file has already been bitten by.
    const files = readdirSync(RT).filter((f) => f.endsWith(".ts"));
    assert.ok(
      files.length > 3,
      `expected the realtime service, saw ${files.length} files`,
    );
    assert.ok(files.includes("main.ts"), "main.ts is the service entry point");
  });
});
