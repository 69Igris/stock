/**
 * The SEC producer's transport can actually REACH this service — MONEY-1520.
 *
 * ## WHAT WENT WRONG, AND WHY NO EXISTING GUARD SAW IT
 *
 * `services/us-fundamentals` (Python) claimed SEC filings every 60 s and POSTed
 * them to `https://stockbook-workers-prod-…/internal/events`. Every call
 * answered **404**. Not 401, not a transport error, not an unset variable —
 * `stockbook-workers-{env}` carries `run.googleapis.com/ingress: internal` and
 * `us-fundamentals-{env}` has no VPC egress, so the request left over the
 * public internet and Cloud Run refused it AT THE EDGE. It never reached Hono.
 * (The status code is the proof: `/internal/*` was gated by `jobsAuth`, which
 * answers 401 on a missing or invalid token and has no 404 path at all.)
 *
 * `instrument_events` held 4,019 rows and not one was `SEC_EDGAR`, while
 * `[job-outcome]` reported `failed: 0` every minute.
 *
 * **`route-registration-coverage.test.ts` was green throughout, and correctly
 * so.** The route WAS mounted; the module WAS in the built artifact; the URL
 * WAS the service's own `status.url`. Every fact that guard checks was true. A
 * route-mounting test cannot see a transport that is refused before it arrives,
 * which is why this file asserts different things:
 *
 *   1. the PRODUCER'S OWN destination constant resolves to a route that exists
 *      — a join across the LANGUAGE seam, which no TypeScript-only scan makes;
 *   2. the producer does not address an `ingress: internal` service over HTTP
 *      at all, which is the property that was violated;
 *   3. the causal fact itself — that this service IS internal-ingress — so the
 *      day someone changes it, this file is what they read.
 *
 * `internal-events-logic.ts` has claimed since C1 that "the seam to the
 * TypeScript side is Mongo + Pub/Sub, never an import — a test enforces that".
 * No such test existed. MONEY-1507 then added a THIRD seam, HTTP, and nothing
 * failed. This is that test, written for the seam that actually broke.
 *
 * Everything here is a FILE COMPARISON. Nothing imports the service, starts a
 * server or talks to GCP — every defect it guards is invisible at runtime until
 * production and, as this ticket proves, invisible in production too.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function findRepoRoot(from: string = process.cwd()): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(join(dir, "turbo.json")) &&
      existsSync(join(dir, "packages"))
    ) {
      return dir;
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate the monorepo root from ${from}`);
}

const REPO_ROOT = findRepoRoot();
const read = (...p: string[]): string =>
  readFileSync(join(REPO_ROOT, ...p), "utf8");

const PRODUCER_APP = join(REPO_ROOT, "services", "us-fundamentals", "app");
const eventsPy = read("services", "us-fundamentals", "app", "events.py");
const indexTs = read("workers", "src", "index.ts");
const pubsubSh = read("workers", "scripts", "setup-pubsub.sh");

/* ═══════════════════════════════════════════════════════════════════════════
   Parsers — pure, so each can be driven with synthetic input
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The Python module-level string constant `NAME = "..."`.
 *
 * Anchored to column 0 so a same-named local inside a function cannot answer
 * for the module's, and returning `null` (never `""`) so "not found" is a state
 * the caller has to handle rather than a value that compares equal to a typo.
 */
export function pythonConstant(src: string, name: string): string | null {
  const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(src);
  return m ? m[1]! : null;
}

/** Every `app.route("<path>", <symbol>)` in index.ts. */
export function mountedPaths(src: string): string[] {
  return [
    ...src.matchAll(/app\.route\(\s*"([^"]+)"\s*,\s*\w+\s*,?\s*\)/gs),
  ].map((m) => m[1]!);
}

/** Quoted entries of a `declare -a NAME=( … )` array, comments stripped. */
export function bashArray(src: string, name: string): string[] {
  const marker = `declare -a ${name}=(`;
  const start = src.indexOf(marker);
  if (start === -1) return [];
  const end = src.indexOf("\n)", start);
  if (end <= start) return [];
  const out: string[] = [];
  for (const raw of src.slice(start + marker.length, end).split("\n")) {
    const line = raw.replace(/#.*$/, "");
    const m = /"([a-z0-9-]+)"/.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/**
 * Python source with COMMENTS and DOCSTRINGS blanked, offsets preserved.
 *
 * PROSE IS NOT CODE. Without this, the very paragraphs explaining why the HTTP
 * hop was removed — which necessarily quote `stockbook-workers` and
 * `/internal/events` — would fail the scan below, and the only way to keep it
 * green would be to stop writing down why. Worse, it fails in the other
 * direction too: the ban would look enforced while a commented example URL was
 * all that tripped it.
 *
 * ONE left-to-right pass, not two regexes. Python has the trap in BOTH
 * directions — a `#` line mentioning `"""` opens a phantom docstring, and
 * `x = """a # b"""` puts a `#` inside a string — so there is no ordering of two
 * passes that is right for both. Whichever delimiter is reached first wins,
 * which is what the interpreter does.
 *
 * Single-line literals are PRESERVED: they are where a URL would actually live.
 */
export function pythonCodeOnly(src: string): string {
  const out = src.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };
  const endOfLiteral = (from: number): number => {
    const ch = src[from]!;
    const triple = ch + ch + ch;
    const isTriple = src.startsWith(triple, from);
    const delim = isTriple ? triple : ch;
    let j = from + delim.length;
    while (j < src.length) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src.startsWith(delim, j)) return j + delim.length;
      if (!isTriple && src[j] === "\n") return j;
      j++;
    }
    return src.length;
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "#") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = endOfLiteral(i);
      if (src.startsWith(ch + ch + ch, i)) blank(i, end);
      i = Math.max(end, i + 1);
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Every `.py` under a directory, recursively. */
function pythonFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".venv" || entry.name === "__pycache__") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pythonFiles(full, out);
    else if (entry.name.endsWith(".py")) out.push(full);
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   The facts under test
   ══════════════════════════════════════════════════════════════════════════ */

const EVENTS_TOPIC = pythonConstant(eventsPy, "EVENTS_TOPIC");
const mounts = mountedPaths(indexTs);
const workerTopics = bashArray(pubsubSh, "BASE_WORKER_TOPICS");
const producerFiles = pythonFiles(PRODUCER_APP);

describe("MONEY-1520 — the scans reach real content", () => {
  it("[premise] every source this suite joins was found and parsed", () => {
    // Floors, not `> 0`. A parser that silently stops matching makes every
    // assertion below pass vacuously — which is the exact shape of the guard
    // that was green while this bug ran (a true statement about the wrong
    // thing).
    assert.equal(
      EVENTS_TOPIC,
      "us-filing-events",
      "app/events.py's EVENTS_TOPIC did not parse, or it moved. Every " +
        "assertion below joins on this value, so an unreadable one turns this " +
        "whole file into a no-op.",
    );
    assert.ok(mounts.length >= 44, `parsed ${mounts.length} route mounts`);
    assert.ok(
      workerTopics.length >= 60,
      `parsed ${workerTopics.length} BASE_WORKER_TOPICS entries`,
    );
    assert.ok(
      producerFiles.length >= 20,
      `found ${producerFiles.length} producer .py files`,
    );
  });

  it("[premise] the comment stripper keeps code and discards prose", () => {
    // Both directions, because a stripper that blanks everything would make
    // the HTTP ban below unfalsifiable, and one that blanks nothing would make
    // it fire on its own explanation.
    const src = [
      'URL = "https://kept.example"',
      "# NOTE: https://commented.example/internal/events",
      '"""A docstring naming https://docstring.example."""',
    ].join("\n");
    const code = pythonCodeOnly(src);
    assert.ok(code.includes("https://kept.example"), "blanked a real literal");
    assert.ok(!code.includes("commented.example"), "kept a # comment");
    assert.ok(!code.includes("docstring.example"), "kept a docstring");
    assert.equal(
      code.split("\n").length,
      src.split("\n").length,
      "line count changed — offsets must be preserved",
    );
  });
});

describe("MONEY-1520 — the producer's destination is a route that exists", () => {
  it("the Python topic constant names a mounted /jobs/ path", () => {
    // THE JOIN ACROSS THE LANGUAGE SEAM. `route-registration-coverage.test.ts`
    // joins BASE_WORKER_TOPICS against the mounts and never reads Python, so a
    // producer whose constant drifts from both would publish into a topic that
    // does not exist — `PublishError` on every run, inside a fail-soft caller.
    assert.ok(
      mounts.includes(`/jobs/${EVENTS_TOPIC}`),
      `services/us-fundamentals publishes to "${EVENTS_TOPIC}", and the push ` +
        `subscription posts to /jobs/${EVENTS_TOPIC} — but no route is mounted ` +
        "there. Every delivery 404s and dead-letters after five attempts, " +
        "which reads as a failing job rather than a misrouted topic.",
    );
  });

  it("the topic has a push subscription, not just a topic", () => {
    // A topic with no subscription is the same total silence the 404 produced:
    // the publish succeeds, the message sits until retention expires, and no
    // counter anywhere moves.
    assert.ok(
      workerTopics.includes(EVENTS_TOPIC!),
      `"${EVENTS_TOPIC}" is not in BASE_WORKER_TOPICS, so setup-pubsub.sh ` +
        "creates no push subscription for it.",
    );
  });

  it("the route is NOT mounted at its old /internal path as well", () => {
    // Two mounts would make the ban below pass while the unreachable door was
    // still open — and an unauthenticated-writer surface is not something to
    // leave standing "just in case".
    assert.ok(
      !mounts.includes("/internal/events"),
      "/internal/events is still mounted. It is unreachable from the producer " +
        "(internal ingress, no VPC egress) and nothing else calls it.",
    );
  });
});

describe("MONEY-1520 — the producer never addresses an internal-ingress service over HTTP", () => {
  it("[premise] stockbook-workers really is ingress: internal in both specs", () => {
    // The CAUSAL FACT, asserted rather than assumed. If someone relaxes it,
    // this is the file they land in — with the whole explanation above.
    for (const env of ["prod", "qa"] as const) {
      const spec = read("workers", `cloudbuild.${env}.yaml`);
      assert.ok(
        /run\.googleapis\.com\/ingress:\s*internal/.test(spec),
        `workers/cloudbuild.${env}.yaml no longer declares internal ingress. ` +
          "That is the fact this whole file reasons from — if it changed " +
          "deliberately, re-read MONEY-1520 before relaxing anything here.",
      );
    }
  });

  it("no producer source names the workers service or its old endpoint", () => {
    const offenders: string[] = [];
    for (const file of producerFiles) {
      const code = pythonCodeOnly(readFileSync(file, "utf8"));
      const hits = [
        ...(code.includes("stockbook-workers") ? ["stockbook-workers"] : []),
        ...(code.includes("/internal/events") ? ["/internal/events"] : []),
        ...(code.includes("EVENTS_ENDPOINT_URL")
          ? ["EVENTS_ENDPOINT_URL"]
          : []),
      ];
      if (hits.length) {
        offenders.push(
          `${file.slice(REPO_ROOT.length + 1)} -> ${hits.join(", ")}`,
        );
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      "These files address `stockbook-workers` directly. That service is " +
        "ingress: internal and this one has no VPC egress, so the call leaves " +
        "over the public internet and Cloud Run answers 404 AT THE EDGE — " +
        "before Hono, before jobsAuth, with nothing in this service's logs but " +
        "a status code that reads like a missing route. The seam is Mongo and " +
        "Pub/Sub. MONEY-1520:\n  " +
        offenders.join("\n  "),
    );
  });

  it("no producer source performs an outbound HTTP call to a Cloud Run host", () => {
    // Broader than the name check, and it is the half that generalises: the
    // next version of this mistake will name a DIFFERENT internal service.
    // `sec.gov`, `api.tiingo.com` and friends are fine — `*.run.app` is not,
    // because every Cloud Run service in this project is internal-ingress.
    const offenders: string[] = [];
    for (const file of producerFiles) {
      const code = pythonCodeOnly(readFileSync(file, "utf8"));
      if (/https?:\/\/[^\s"']*\.run\.app/.test(code)) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      "a *.run.app URL in producer code. Cross-service calls in this project " +
        "go over Pub/Sub; a direct one is refused at the edge:\n  " +
        offenders.join("\n  "),
    );
  });
});
