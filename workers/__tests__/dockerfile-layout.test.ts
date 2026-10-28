/**
 * STATIC GUARD — MONEY-1169. The workers Dockerfile must never overlay-merge
 * two node_modules trees onto one path again.
 *
 * ## What went wrong
 *
 * The runtime stage used to do:
 *
 *   COPY --from=builder /app/node_modules ./node_modules
 *   COPY --from=builder /app/workers/node_modules ./node_modules   <- MERGE
 *
 * Docker COPY merges directory contents, so files present in both trees are
 * taken from the SECOND copy. workers/node_modules exists precisely because
 * yarn could NOT hoist those packages — version conflicts — which means every
 * file it contributes is one that MUST NOT shadow the root copy. The merge
 * promoted node-fetch@3.3.2 (nested there for gcp-metadata) over the root's
 * node-fetch@2.7.0, swapping the HTTP client underneath
 * @google-cloud/storage's transports. Result: every multipart upload from the
 * image was stored VERBATIM as object content for ~3 months, and the
 * resumable path failed with "URL is required." — two upload paths broken by
 * one COPY line.
 *
 * The fixed layout preserves yarn's on-disk structure (dist under
 * /app/workers with its own node_modules BESIDE it, root node_modules above),
 * so Node's resolution walks exactly the chain yarn validated at install.
 *
 * Static, not behavioural, because the failure was invisible to every local
 * test: only the built image has the merged tree. What a test CAN hold is the
 * Dockerfile's shape.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(
  join(import.meta.dirname, "..", "Dockerfile"),
  "utf-8",
);

/** COPY destinations in the RUNTIME stage (after the last FROM). */
function runtimeCopyDestinations(): string[] {
  const stages = dockerfile.split(/^FROM /m);
  const runtime = stages[stages.length - 1]!;
  return runtime
    .split("\n")
    .filter((l) => l.trim().startsWith("COPY "))
    .map((l) => l.trim().split(/\s+/).pop()!);
}

describe("workers Dockerfile layout (MONEY-1169)", () => {
  it("never copies two sources onto the same node_modules destination", () => {
    const dests = runtimeCopyDestinations().filter((d) =>
      d.includes("node_modules"),
    );
    const seen = new Set<string>();
    for (const d of dests) {
      assert.ok(
        !seen.has(d),
        `two COPY instructions target ${d} — that overlay-merge is what ` +
          "swapped node-fetch majors under the GCS SDK and corrupted every " +
          "uploaded object (MONEY-1169)",
      );
      seen.add(d);
    }
  });

  it("keeps workers' conflicted deps SCOPED under ./workers/node_modules", () => {
    const dests = runtimeCopyDestinations();
    assert.ok(
      dests.includes("./workers/node_modules"),
      "workers/node_modules must be copied BESIDE the app tree " +
        "(./workers/node_modules), preserving yarn's nested-resolution layout",
    );
    assert.ok(
      dests.includes("./node_modules"),
      "root node_modules must still be copied to ./node_modules",
    );
  });

  it("runs from /app/workers so dist/ resolves the nested layout", () => {
    // WORKDIR must switch to /app/workers before CMD — the jobs' Cloud Run
    // specs (`--command=node,dist/feed-*.js`) inherit this working directory.
    const workdirIdx = dockerfile.lastIndexOf("WORKDIR /app/workers");
    const cmdIdx = dockerfile.lastIndexOf("CMD [");
    assert.ok(workdirIdx !== -1, "runtime stage must set WORKDIR /app/workers");
    assert.ok(
      workdirIdx < cmdIdx,
      "WORKDIR /app/workers must precede the CMD",
    );
  });
});
