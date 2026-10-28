/**
 * The converter's OOM ceiling and the container it runs in — MONEY-1314.
 *
 * These are two spellings of one fact and they had already disagreed. The
 * ceiling was derived against "2048 MiB", which is what the backfill JOB gets;
 * the workers SERVICE ships `memory: 1Gi`. So the refusal ceiling sat 1.6x
 * ABOVE the real limit and admitted any file up to ~319 MB, while the corpus
 * maximum is 222.3 MB and 109 objects exceed 40 MB.
 *
 * An OOM kill on Cloud Run is not a per-document failure: it takes the whole
 * container, every other in-flight message with it, each possibly mid-Gemini-
 * call. So the agreement is asserted rather than commented.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  maxEstimatedRssBytes,
  containerMemoryMi,
  NODE_FLOOR_MI,
} from "../src/lib/doc-convert";
import { estimatePeakRssBytes } from "@usemoney/core/market-data/doc-convert-logic";

const WORKERS_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const SPECS = ["cloudbuild.prod.yaml", "cloudbuild.qa.yaml"];

/** The `memory:` limit of the MAIN worker container, in MiB. */
function declaredMemoryMi(spec: string): number {
  const src = readFileSync(path.join(WORKERS_DIR, spec), "utf8");
  // The first `memory:` under the main container. A later 256Mi belongs to the
  // Datadog sidecar, which is why this takes the FIRST and asserts a floor.
  const m = src.match(/^\s*memory:\s*(\d+)(Gi|Mi)\s*$/m);
  assert.ok(m, `${spec}: no memory: limit found — this scan is blind`);
  const n = Number(m![1]);
  return m![2] === "Gi" ? n * 1024 : n;
}

/** The value the spec passes to the converter. */
function declaredContainerMi(spec: string): number | null {
  const src = readFileSync(path.join(WORKERS_DIR, spec), "utf8");
  const m = src.match(
    /- name: DOC_CONVERT_CONTAINER_MI\s*\n\s*value: "(\d+)"/,
  );
  return m ? Number(m[1]) : null;
}

describe("MONEY-1314 — DOC_CONVERT_CONTAINER_MI matches the real limit", () => {
  it("[premise] both specs declare a memory limit this scan can read", () => {
    // A scan that finds nothing reports every assertion green.
    for (const spec of SPECS) {
      const mi = declaredMemoryMi(spec);
      assert.ok(mi >= 256, `${spec}: parsed an implausible ${mi} MiB`);
    }
  });

  it("every spec passes DOC_CONVERT_CONTAINER_MI at all", () => {
    // It was in NEITHER spec, which is how the ceiling silently defaulted to a
    // number describing a different container.
    for (const spec of SPECS) {
      assert.notEqual(
        declaredContainerMi(spec),
        null,
        `${spec} does not declare DOC_CONVERT_CONTAINER_MI, so the converter ` +
          "sizes its OOM ceiling from a default that may not describe this " +
          "container at all",
      );
    }
  });

  it("the declared value EQUALS the container's memory limit", () => {
    for (const spec of SPECS) {
      assert.equal(
        declaredContainerMi(spec),
        declaredMemoryMi(spec),
        `${spec}: DOC_CONVERT_CONTAINER_MI and the container's memory: limit ` +
          "disagree. The converter refuses documents by estimated peak RSS " +
          "(2.3-4.8x file size); if this number is larger than the real limit, " +
          "the guard passes documents that OOM-kill the container",
      );
    }
  });

  it("the ceiling fits inside the container, with room for neighbours", () => {
    for (const spec of SPECS) {
      const mi = declaredMemoryMi(spec);
      const ceiling = maxEstimatedRssBytes({
        DOC_CONVERT_CONTAINER_MI: String(mi),
      });
      assert.ok(
        ceiling < (mi - NODE_FLOOR_MI) * 1024 * 1024,
        `${spec}: ceiling ${Math.round(ceiling / 1e6)} MB does not fit ${mi} MiB`,
      );
      // containerConcurrency is 10 — the conversion is never alone, and the
      // caller downloads the object BEFORE acquiring the convert semaphore.
      assert.ok(ceiling <= (mi - NODE_FLOOR_MI) * 1024 * 1024 * 0.6);
    }
  });

  it("[control] a 2 GiB container earns a LARGER ceiling", () => {
    // Proves the derivation reads the value rather than returning a constant —
    // and it is how the backfill JOB, at 2 GiB, reaches the 222 MB documents
    // the 1 GiB service declines.
    assert.ok(
      maxEstimatedRssBytes({ DOC_CONVERT_CONTAINER_MI: "2048" }) >
        maxEstimatedRssBytes({ DOC_CONVERT_CONTAINER_MI: "1024" }),
    );
  });

  it("names the file size the SERVICE will actually decline", () => {
    // Stated as a number so the deferral is visible rather than discovered.
    // These documents are not lost: the backfill JOB runs at 2 GiB with
    // concurrency 1 and reaches them.
    const ceiling = maxEstimatedRssBytes({ DOC_CONVERT_CONTAINER_MI: "1024" });
    let mb = 1;
    while (estimatePeakRssBytes(mb * 1024 * 1024) <= ceiling) mb++;
    assert.ok(
      mb > 40 && mb < 222,
      `the 1 GiB service declines documents over ~${mb} MB — outside the ` +
        "expected 40-222 MB band, so either the multiplier or the share moved",
    );
  });

  it("the default matches what the specs declare — no silent third value", () => {
    assert.equal(containerMemoryMi({}), declaredMemoryMi("cloudbuild.prod.yaml"));
  });
});

describe("MONEY-1314 — DOC_INGEST_REALTIME ships PRESENT and \"false\"", () => {
  // Four artifacts in this branch assert it "ships false" — workers/CLAUDE.md,
  // a shipped test comment, apply-monitors.sh's replacement block, and the
  // synthesis doc — and it was in NEITHER spec. Absent and explicitly-false
  // are not the same state: absent is exactly how MF_METADATA_PROVIDER
  // disabled its job silently for months (MONEY-1214), and here it would mean
  // four documents describing a switch nobody can see or flip.
  const value = (spec: string): string | null => {
    const src = readFileSync(path.join(WORKERS_DIR, spec), "utf8");
    const m = src.match(/- name: DOC_INGEST_REALTIME\s*\n\s*value: "([^"]*)"/);
    return m ? m[1]! : null;
  };

  it("is declared in BOTH specs", () => {
    for (const spec of SPECS) {
      assert.notEqual(
        value(spec),
        null,
        `${spec} does not declare DOC_INGEST_REALTIME. Four artifacts in this ` +
          'branch say it "ships false"; absent is a different state, and an ' +
          "operator cannot see or flip a switch that is not in the spec",
      );
    }
  });

  it("ships DISARMED — the drain runs before realtime does", () => {
    // Arming it before the backfill drains makes the realtime lane and the
    // job compete for the same rows. The runbook flips it as a deliberate
    // deploy, in the same change that adds the freshness monitor.
    for (const spec of SPECS) {
      assert.equal(value(spec), "false", `${spec} ships it armed`);
    }
  });

  it("[control] the scan can tell present-and-false from absent", () => {
    // Proves the reader distinguishes the two states it exists to separate.
    const m = 'x\n- name: DOC_INGEST_REALTIME\n  value: "true"\n'.match(
      /- name: DOC_INGEST_REALTIME\s*\n\s*value: "([^"]*)"/,
    );
    assert.equal(m?.[1], "true");
    assert.equal(
      "nothing here".match(/- name: DOC_INGEST_REALTIME\s*\n\s*value: "([^"]*)"/),
      null,
    );
  });
});
