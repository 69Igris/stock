/**
 * The workers image runs a Node that can decode the vendor stream — MONEY-1373.
 *
 * Databento ships batch files as `.csv.zst` and we decode them with
 * `node:zlib`'s `createZstdDecompress`, which landed in Node 22.15. On Node 20
 * that export is simply `undefined`: the call throws `TypeError: ... is not a
 * function` at the moment a harvested file is opened, hours after the job that
 * paid for it succeeded. That reads as a corrupt download rather than as a
 * missing runtime, which is why the runtime is pinned in a test rather than
 * left to whoever next edits the Dockerfile.
 *
 * FOUR PLACES SAY "node 20/22" and they must agree, because each one is the
 * only authority for a different stage:
 *
 *   workers/Dockerfile         both FROM lines — the builder AND the runtime.
 *                              Bumping only the builder produces an image that
 *                              BUILDS on 22 and RUNS on 20, i.e. exactly the
 *                              failure this file exists to prevent, with the
 *                              build log looking correct.
 *   workers/tsup.config.ts     esbuild's downlevel target. Left at node20 the
 *                              bundle still runs, so nothing fails — it just
 *                              silently forgoes syntax the runtime supports.
 *   cloudbuild.integration.yaml  the CI steps' own container.
 *
 * The `[premise]` case is what stops this suite from being self-satisfied
 * string-matching: it asserts the CURRENT process has the export, so the file
 * cannot pass on a runtime that lacks the very thing it is pinning.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** CWD is packages/core when this suite runs. */
const ROOT = join(process.cwd(), "..", "..");
const DOCKERFILE = join(ROOT, "workers", "Dockerfile");
const TSUP = join(ROOT, "workers", "tsup.config.ts");
const CLOUDBUILD_INTEGRATION = join(ROOT, "cloudbuild.integration.yaml");

const dockerfileSrc = readFileSync(DOCKERFILE, "utf8");
const tsupSrc = readFileSync(TSUP, "utf8");
const integrationSrc = readFileSync(CLOUDBUILD_INTEGRATION, "utf8");

describe("MONEY-1373 — the workers runtime is Node 22", () => {
  it("[premise] this Node has zlib.createZstdDecompress", async () => {
    // The whole point of the bump. If the suite can pass on a runtime WITHOUT
    // the export, then every assertion below is checking a string rather than a
    // capability — and the developer machine would disagree with the image for
    // exactly as long as nobody looked.
    const zlib = await import("node:zlib");
    assert.equal(
      typeof zlib.createZstdDecompress,
      "function",
      "node:zlib has no createZstdDecompress — this runtime is below 22.15 and " +
        "cannot decode Databento's .csv.zst batch files",
    );
  });

  it("BOTH workers/Dockerfile stages are node:22-alpine", () => {
    // Counted, not merely matched. There are two FROM lines (builder +
    // runtime) and the runtime one is 40 lines below the other, so bumping one
    // and missing the other is the easy mistake — and it produces an image that
    // builds green and dies on the first zstd read.
    const twentyTwo = dockerfileSrc.match(/^FROM node:22-alpine/gm) ?? [];
    assert.equal(
      twentyTwo.length,
      2,
      `workers/Dockerfile has ${twentyTwo.length} node:22-alpine FROM lines, expected 2 ` +
        "(builder + production runtime)",
    );
    assert.equal(
      (dockerfileSrc.match(/node:20-alpine/g) ?? []).length,
      0,
      "workers/Dockerfile still references node:20-alpine — the stage left behind " +
        "is the one that runs, and zlib.createZstdDecompress does not exist there",
    );
  });

  it("workers/tsup.config.ts targets node22", () => {
    assert.match(
      tsupSrc,
      /target:\s*"node22"/,
      'workers/tsup.config.ts must set target: "node22" — esbuild downlevels to ' +
        "whatever it is told, so a stale node20 target silently costs syntax the " +
        "image supports and never fails",
    );
  });

  it("cloudbuild.integration.yaml runs no node:20 step", () => {
    // CI running an older Node than the image is how a runtime-only defect
    // reaches production green: the suite passes on the CI container and the
    // capability it depends on is absent from neither.
    assert.equal(
      (integrationSrc.match(/node:20/g) ?? []).length,
      0,
      "cloudbuild.integration.yaml still runs a node:20 builder step — CI would " +
        "test on an older runtime than workers/Dockerfile ships",
    );
  });
});
