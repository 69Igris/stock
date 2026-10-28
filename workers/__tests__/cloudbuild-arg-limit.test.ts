/**
 * UNIT TEST — Cloud Build single-arg size limit (MONEY-1097).
 *
 * `workers/cloudbuild.{prod,qa}.yaml` deploy Cloud Run by piping an entire
 * `service.yaml` into one inline `bash -c` argument. Cloud Build caps ONE
 * argument at 10,000 characters, and exceeding it fails the whole build with:
 *
 *   invalid build: invalid .steps field: build step 2 arg 1 too long (max: 10000)
 *
 * ## Why this needs a test rather than care
 *
 * The failure mode is uniquely nasty for a deploy spec:
 *
 *   - It is invisible in review. Adding four lines of env var to a 300-line
 *     YAML looks harmless, and nothing local catches it — `yarn build`,
 *     `yarn test` and every type-check pass, because the file is data, not code.
 *   - It fails at DEPLOY time, i.e. after merge, when someone is mid-release.
 *   - The margin is thin and shrinking. Prod sat at 9,552 of 10,000 — 448
 *     characters from the wall — and every new secret eats into that. A single
 *     added comment block was enough to tip it over and break the deploy.
 *
 * The fix that bought headroom was moving the commentary OUT of the heredoc:
 * comments outside the arg cost nothing, comments inside it count. This test
 * exists so that arrangement cannot quietly rot back.
 *
 * Pure file parsing: no network, no GCP, no build.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Cloud Build's documented per-argument ceiling. */
const MAX_ARG_CHARS = 10_000;

/**
 * Warn well before the wall. ~700 characters is roughly a dozen env-var
 * entries — enough runway to notice and relocate commentary rather than
 * discover the limit during a release.
 */
const HEADROOM_WARN_CHARS = 700;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKERS_DIR = path.resolve(HERE, "..");

/**
 * Length of the longest inline (`- |`) literal-block argument in a build spec.
 *
 * ## The block indentation MUST be stripped
 *
 * A YAML literal block scalar removes the indentation common to all its lines,
 * so what Cloud Build actually receives is the DEDENTED text. Measuring the raw
 * file lines overcounts by (indent x line count) — here 8 x ~250 = ~2,000
 * characters, which is 20% of the entire budget.
 *
 * That is not a rounding error, it inverts conclusions. Measured raw, this spec
 * read 11,600 and looked like it had been over the limit for ages; measured
 * correctly it was 9,552 and fine, and a single added comment block was what
 * actually broke the deploy. A guard that overcounts would also fail builds
 * that are perfectly valid.
 */
function longestInlineArg(file: string): { chars: number; startLine: number } {
  const lines = readFileSync(file, "utf8").split("\n");
  let best = { chars: 0, startLine: -1 };

  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "- |") continue;

    const block: string[] = [];
    let indent: number | null = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") {
        block.push(line);
        continue;
      }
      const cur = line.length - line.trimStart().length;
      if (indent === null) indent = cur;
      if (cur < indent) break;
      block.push(line);
    }

    const strip = indent ?? 0;
    const chars = block
      .map((l) => (l.length >= strip ? l.slice(strip) : l))
      .join("\n").length;
    if (chars > best.chars) best = { chars, startLine: i + 1 };
  }

  return best;
}

const SPECS = ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"];

describe("cloudbuild: inline arg stays under Cloud Build's 10k limit", () => {
  for (const spec of SPECS) {
    it(`${spec} is deployable`, () => {
      const file = path.join(WORKERS_DIR, spec);
      const { chars, startLine } = longestInlineArg(file);

      assert.ok(
        chars > 0,
        `${spec}: found no inline '- |' argument to measure`,
      );
      assert.ok(
        chars <= MAX_ARG_CHARS,
        `${spec}: inline arg at line ${startLine} is ${chars} chars, over Cloud ` +
          `Build's ${MAX_ARG_CHARS} limit by ${chars - MAX_ARG_CHARS}. The deploy ` +
          `WILL fail with "build step 2 arg 1 too long". Move commentary OUT of ` +
          `the heredoc (comments above the step do not count toward the arg).`,
      );
    });

    it(`${spec} keeps usable headroom`, () => {
      const { chars } = longestInlineArg(path.join(WORKERS_DIR, spec));
      const headroom = MAX_ARG_CHARS - chars;
      assert.ok(
        headroom >= HEADROOM_WARN_CHARS,
        `${spec}: only ${headroom} chars of headroom left (want >= ` +
          `${HEADROOM_WARN_CHARS}). The next few env vars will break the deploy. ` +
          `Relocate comments out of the heredoc before adding more.`,
      );
    });
  }

  it("prod still declares FEED_ARCHIVE_MODE inside the heredoc", () => {
    // The comment relocation moved 46 lines out of the prod heredoc. This
    // pins the one line that had to STAY: a comment can live outside the arg,
    // but the env entry itself must be inside the generated service.yaml or
    // the archive silently reverts to disabled.
    const prod = readFileSync(
      path.join(WORKERS_DIR, "cloudbuild.prod.yaml"),
      "utf8",
    );
    assert.match(prod, /- name: FEED_ARCHIVE_MODE\s*\n\s*value: "archive"/);
    assert.match(prod, /- name: GCP_STORAGE_BUCKET/);
  });
});

/**
 * RESERVED Cloud Run env names (MONEY-1309).
 *
 * This suite already existed for one deploy-time-only failure — the 10,000-char
 * single-arg limit — and its header states the class exactly: "invisible in
 * review… nothing local catches it… it fails at DEPLOY time." The guard built
 * for it was single-purpose, so the SECOND member of the same class went
 * straight through:
 *
 *   ERROR: (gcloud.run.services.replace) spec.template.spec.containers[0].env:
 *   The following reserved env names were provided: PORT.
 *   These values are automatically set by the system.
 *
 * Both `main` and `release` failed on it, leaving QA and prod un-deployed and
 * `tiingo-realtime-{env}` never created. `yarn verify:push` cannot see it:
 * coverage-check, type-check, build and test all pass, because the spec is
 * DATA. Only `gcloud run services replace` validates it, and that runs after
 * the image is built.
 *
 * Cloud Run injects all four of these itself. `PORT` is derived from
 * `containerPort`, which is the correct and sufficient way to say it.
 */
describe("cloudbuild: no Cloud Run RESERVED env name is declared", () => {
  const RESERVED = ["PORT", "K_SERVICE", "K_REVISION", "K_CONFIGURATION"];

  it("[premise] the specs are readable and declare a containerPort", () => {
    // Without this the scan below passes by reading nothing, and a spec that
    // stopped declaring its port would look identical to a clean one.
    for (const spec of SPECS) {
      const src = readFileSync(path.join(WORKERS_DIR, spec), "utf8");
      assert.ok(src.length > 0, `${spec} is empty`);
      assert.match(
        src,
        /containerPort:\s*\d+/,
        `${spec} declares no containerPort — Cloud Run cannot derive PORT`,
      );
    }
  });

  for (const spec of SPECS) {
    it(`${spec} declares no reserved env name`, () => {
      const offenders: string[] = [];
      readFileSync(path.join(WORKERS_DIR, spec), "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = /^\s*-\s*name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
          if (m && RESERVED.includes(m[1]!)) {
            offenders.push(`${spec}:${i + 1} declares ${m[1]}`);
          }
        });
      assert.deepEqual(
        offenders,
        [],
        "Cloud Run RESERVES these and REFUSES the deploy:\n  " +
          offenders.join("\n  ") +
          "\n\nSet the port with `ports: - containerPort: N` and let Cloud Run " +
          "set PORT to match. This fails at `services replace`, after the image " +
          "is built — no local check sees it.",
      );
    });
  }

  it("[control] the detector finds a reserved name when one is present", () => {
    // Proves the scan can fail. Without it, a broken regex would report every
    // spec clean while checking nothing — which is how the first version of
    // this guard would have looked on the day the bug shipped.
    const synthetic = ["                    - name: PORT", '                      value: "8082"'];
    const found = synthetic.filter((line) => {
      const m = /^\s*-\s*name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(line);
      return m !== null && RESERVED.includes(m[1]!);
    });
    assert.equal(found.length, 1, "the detector must match the real offending line");
  });
});
