/**
 * MONEY-1229 — every surface that names the Datadog SITE names the same one.
 *
 * ## Why a site mismatch has to be a test and not a comment
 *
 * The org moved from `us3.datadoghq.com` to `us5.datadoghq.com` in September
 * 2026, and the old site was written down in SEVEN live places: the TypeScript
 * constant (which the metrics reporter, the logs intake URL and
 * apply-monitors.sh derive from), the browser RUM init, the four Cloud Build
 * sidecar specs, and the manual deploy script. Six of those cannot import the
 * seventh — a YAML env block and a shell heredoc carry a plain string — so the
 * fact exists in several spellings by construction, and spellings drift.
 *
 * A drifted site does not fail. An API key minted on one site is answered 403
 * by another; the HTTP metrics client and the logs transport both swallow that;
 * the serverless-init sidecar logs it once and keeps running. So the symptom is
 * a series that never arrives — NO DATA — which is indistinguishable from
 * health once the no-data notification is muted, and is the exact shape this
 * package's history is made of (MONEY-1238: metric name, env tag, API host).
 *
 * ## What is asserted
 *
 * The DEPLOY SURFACES against the CONSTANT, not against a literal typed here.
 * A test that compared each file to `"us5.datadoghq.com"` would go green on a
 * future move the moment someone updated the test's own literal, with the
 * constant still on the old site. Reading `DD_SITE` from the source keeps the
 * constant the single source of truth: change it, and every surface below has
 * to move with it or this file goes red.
 *
 * Mutation-checked both ways: flipping ONE sidecar spec back to us3 fails the
 * per-file assertion; flipping the CONSTANT back to us3 fails all five.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DD_LOGS_INTAKE_URL, DD_SITE } from "../src/constants";
import { tracerConfig } from "../src/tracer";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * Every file that carries the site as a PLAIN STRING because it cannot import
 * the constant. Adding a fifth Cloud Run sidecar means adding its spec here —
 * a sidecar missing from this list is a sidecar nobody is checking.
 */
const SIDECAR_SPECS = [
  "workers/cloudbuild.prod.yaml",
  "workers/cloudbuild.qa.yaml",
  "services/us-fundamentals/cloudbuild.prod.yaml",
  "services/us-fundamentals/cloudbuild.qa.yaml",
  // MONEY-1466 — the UDF datafeed's sidecar. Added in the same change that
  // created the specs, which is what the comment above this list asks for: a
  // sidecar missing from here is a sidecar nobody is checking, and on the next
  // org move the listed surfaces go red and get fixed while the unlisted ones
  // stay pointed at the old site. The agent is then answered 403, logs it once,
  // and keeps running — so the symptom is NO DATA, never an error.
  "apps/market-data/cloudbuild.prod.yaml",
  "apps/market-data/cloudbuild.qa.yaml",
  "workers/scripts/deploy.sh",
] as const;

/**
 * The file that builds the RUM init object, which is NOT the provider component.
 * MONEY-726 moved the object out of `DatadogRumProvider.tsx` into this leaf so
 * the error boundaries could reuse it — the provider now imports a config and
 * imports no site at all, so pointing this at the component asserts the absence
 * of a constant the component is right not to have.
 */
const RUM_PROVIDER = "apps/web/lib/datadog/rum-init.ts";

/**
 * The Python service carries its own copy of the site, and it is the one
 * surface nobody was pinning. A Cloud Run JOB has no `datadog-agent` sidecar,
 * so `app/store/outcome.py` POSTs its four counters straight at the v1 intake —
 * `_http_send_series` is now the ONLY metrics path the five EDGAR jobs have —
 * and a Python module cannot import a TypeScript constant.
 *
 * The only other assertion on that literal lives in `tests/test_outcome.py` as
 * `https://api.us5.datadoghq.com/api/v1/series`, which is literal-vs-literal:
 * it moves in lockstep with the thing it checks and can never disagree with it.
 * So on the next org move every surface above goes red and gets fixed while
 * this one stays stale, `_http_send_series` is answered 403, and the caller
 * swallows it — the exact NO-DATA-that-looks-like-health this file exists for.
 */
const PY_SITE_MODULE = "services/us-fundamentals/app/settings.py";

/**
 * MONEY-1466 — the market-data smoke test queries the APM spans API directly,
 * so it carries the site as a literal for the same reason the Python module
 * does: a bash script cannot import a TypeScript constant.
 *
 * It is listed here rather than left unchecked because its failure mode is the
 * quietest in this file. On a stale site the request is answered 403, the
 * script counts ZERO spans, and it reports the one thing that is never true —
 * "the dd-trace loader is not taking effect" — sending the next reader to
 * rebuild a Dockerfile that was always correct.
 */
const SMOKE_SCRIPT = "scripts/ops/market-data-smoke.sh";

/** `DD_SITE="us5.datadoghq.com"` — a shell assignment. */
const SH_SITE_RE = /^DD_SITE="([^"]+)"/m;

/** `DD_SITE = "us5.datadoghq.com"` — a Python assignment, not a YAML pair. */
const PY_SITE_RE = /^DD_SITE\s*=\s*"([^"]+)"/m;

/** `- name: DD_SITE` followed by its `value:` line, in YAML or a shell heredoc. */
const SIDECAR_SITE_RE = /name:\s*DD_SITE\s*\n\s*value:\s*"?([^\s"]+)"?/g;

/** Any Datadog site hostname, whichever region. */
const ANY_SITE_RE = /\b(?:[a-z0-9]+\.)?datadoghq\.(?:com|eu)\b/g;

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("MONEY-1229 — the Datadog site is one fact, spelled once", () => {
  it("the constant is a real site hostname, and it is the one the org is on", () => {
    assert.match(DD_SITE, /^[a-z0-9]+\.datadoghq\.(com|eu)$/, DD_SITE);
    // A regression to the previous org's site is the one value that would
    // LOOK valid to every other check here and still send everything to an
    // org that no longer holds our keys.
    assert.notEqual(DD_SITE, "us3.datadoghq.com", "the us3 org was replaced");
  });

  it("the market-data smoke script's site literal equals the constant", () => {
    const src = read(SMOKE_SCRIPT);
    const m = SH_SITE_RE.exec(src);
    assert.ok(
      m,
      `${SMOKE_SCRIPT} no longer assigns DD_SITE — did it stop querying the API?`,
    );
    assert.equal(
      m![1],
      DD_SITE,
      `${SMOKE_SCRIPT} queries api.${m![1]} while the org is on ${DD_SITE}. ` +
        "A stale site is answered 403, the span count reads ZERO, and the " +
        "script then blames the dd-trace loader for a working Dockerfile.",
    );
    // And no OTHER site hostname anywhere in the file.
    const others = [...src.matchAll(ANY_SITE_RE)]
      .map((x) => x[0])
      .filter((h) => h !== DD_SITE);
    assert.deepEqual(
      [...new Set(others)],
      [],
      `${SMOKE_SCRIPT} also mentions: ${others.join(", ")}`,
    );
  });

  it("the logs intake URL is derived from the constant, not a second literal", () => {
    assert.ok(
      DD_LOGS_INTAKE_URL.includes(`.${DD_SITE}/`),
      `${DD_LOGS_INTAKE_URL} does not embed ${DD_SITE}`,
    );
  });

  for (const spec of SIDECAR_SPECS) {
    it(`${spec} — every sidecar DD_SITE equals the constant`, () => {
      const src = read(spec);
      const sites = [...src.matchAll(SIDECAR_SITE_RE)].map((m) => m[1]);
      // At least one sidecar block must exist, or the file dropped the agent
      // and this assertion would pass vacuously over nothing.
      assert.ok(sites.length >= 1, `${spec}: no \`name: DD_SITE\` block found`);
      for (const site of sites) {
        assert.equal(site, DD_SITE, `${spec} sends the sidecar to ${site}`);
      }
      // And no OTHER site hostname anywhere in the file — a stale value in a
      // comment or a second container is how the next reader copies it back.
      const others = [...src.matchAll(ANY_SITE_RE)]
        .map((m) => m[0])
        .filter((h) => h !== DD_SITE);
      assert.deepEqual(others, [], `${spec} still names ${others.join(", ")}`);
    });
  }

  it(`${PY_SITE_MODULE} — the Python service's site equals the constant`, () => {
    const src = read(PY_SITE_MODULE);
    const match = PY_SITE_RE.exec(src);
    // The assignment must EXIST. A renamed constant would otherwise make this
    // pass over a file that still names the old site somewhere else.
    assert.ok(match, `${PY_SITE_MODULE}: no \`DD_SITE = "..."\` assignment`);
    assert.equal(
      match[1],
      DD_SITE,
      `${PY_SITE_MODULE} sends the five EDGAR jobs to ${match[1]}`,
    );
    const others = [...src.matchAll(ANY_SITE_RE)]
      .map((m) => m[0])
      .filter((h) => h !== DD_SITE);
    assert.deepEqual(
      others,
      [],
      `${PY_SITE_MODULE} still names ${others.join(", ")}`,
    );
  });

  it("the browser RUM init reads the constant and hardcodes no site", () => {
    const src = read(RUM_PROVIDER);
    assert.match(
      src,
      /import\s*\{[^}]*\bDD_SITE\b[^}]*\}\s*from\s*"@usemoney\/datadog\/constants"/,
      "DatadogRumProvider must import DD_SITE from @usemoney/datadog/constants",
    );
    assert.match(
      src,
      /\bsite:\s*DD_SITE\b/,
      "RUM init must pass site: DD_SITE",
    );
    const literals = [...src.matchAll(ANY_SITE_RE)].map((m) => m[0]);
    assert.deepEqual(
      literals,
      [],
      `RUM provider hardcodes ${literals.join(", ")}`,
    );
  });
});

describe("MONEY-1380 — the TRACER states the site, so agentless cannot mis-route", () => {
  it("tracerConfig emits the constant, not dd-trace's default", () => {
    // dd-trace reads DD_SITE and otherwise defaults to `datadoghq.com` — US1,
    // a DIFFERENT ORG from ours. That default is invisible while everything
    // posts to a local agent (the agent carries its own DD_SITE), and becomes
    // load-bearing the instant anything runs AGENTLESS, which is exactly what
    // web and api do for LLM Observability: the writer posts to
    // `https://api.{site}`, so a us5 key presented to US1 is answered 403,
    // logged through dd-trace's internal logger, and DROPPED.
    //
    // DD_SITE is NOT in the Vercel environment for either app, so inheriting it
    // would have made the wrong org the default outcome rather than an edge
    // case — and the symptom is an empty LLM Obs page, which is what a feature
    // nobody used also looks like.
    const c = tracerConfig({ service: "stockbook-web" }, "production", {});
    assert.equal(
      (c as { site?: string }).site,
      DD_SITE,
      "tracerConfig must state `site` from constants.ts",
    );
  });

  it("states it even when DD_SITE in the environment disagrees", () => {
    // The constant is the single source. An env var that contradicts it is a
    // misconfiguration, not an override — and silently honouring it would
    // re-open exactly the split-brain this file exists to prevent.
    const c = tracerConfig({ service: "stockbook-api" }, "production", {
      DD_SITE: "datadoghq.eu",
    });
    assert.equal((c as { site?: string }).site, DD_SITE);
  });
});

/**
 * `DD_ENV` on a PROD surface is `production`, never `prod` — MONEY-1467.
 *
 * Every Datadog monitor, dashboard and SLO in this repo filters on
 * `env:production` (`DD_ENV_TAG` in `apply-service-monitors.sh:57` and
 * `apply-perf-monitors.sh:80`). A service tagged `env:prod` is therefore
 * invisible to ALL of them — its spans arrive, its traces are searchable by
 * hand, and every alert over it sits in NO DATA forever, which is
 * indistinguishable from a healthy idle service.
 *
 * `apps/market-data/cloudbuild.prod.yaml` shipped `"prod"`. It was found by
 * querying `trace.web.request.hits{env:production}` for a service that was
 * demonstrably emitting spans and getting ZERO — the same measurement any
 * monitor's preflight would have made, at which point the row would have been
 * refused with "check the service is tracing", pointing at the wrong thing.
 * (That query was empty for a SECOND reason too: the service is Hono, so its
 * server span is `hono.request`, measured in MONEY-1468. Which span each
 * service emits is declared once, in DD_SERVER_SPAN — MONEY-1534.)
 *
 * QA is unaffected: the tag and the environment name are both `qa`.
 */
describe("MONEY-1467 — a prod surface tags DD_ENV as `production`", () => {
  const PROD_SPECS = [
    "workers/cloudbuild.prod.yaml",
    "services/us-fundamentals/cloudbuild.prod.yaml",
    "apps/market-data/cloudbuild.prod.yaml",
  ] as const;

  for (const spec of PROD_SPECS) {
    it(`${spec} — every DD_ENV is "production"`, () => {
      const src = read(spec);
      const values = [
        ...src.matchAll(/name:\s*DD_ENV\s*\n\s*value:\s*"?([\w-]+)"?/g),
      ].map((m) => m[1]);
      // A spec with no DD_ENV at all would pass vacuously.
      assert.ok(values.length >= 1, `${spec}: no DD_ENV block found`);
      for (const v of values) {
        assert.equal(
          v,
          "production",
          `${spec} tags DD_ENV=${v}; every monitor filters env:production, so this ` +
            "surface would be invisible to all of them while looking perfectly healthy",
        );
      }
    });
  }
});
