/**
 * job.service getJobStatus — REAL export, injected prisma (MONEY-731).
 *
 * `@usemoney/services` runs its suite as ESM (no `require.cache` prisma
 * injection), so a fake prisma is injected via the function's `deps` seam. This
 * pins the IDOR-critical contract on the code that ships:
 *   - the lookup WHERE carries BOTH `jobId` AND the caller's `userId` (a
 *     foreign/guessed jobId matches zero rows → 404, no cross-user oracle),
 *   - the select is the payload-free status whitelist (raw `payload` is NEVER
 *     returned to the client),
 *   - a null row and a thrown query both fail closed to a sanitised
 *     not-found/error result (the route maps not-found → 404).
 *
 * Source: packages/services/src/job.service.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getJobStatus, type GetJobStatusDeps } from "../src/job.service";

interface RecordedCall {
  where?: unknown;
  select?: unknown;
}

/** Fake prisma exposing only the backgroundJob.findFirst delegate. */
function fakePrisma(row: unknown): {
  prisma: GetJobStatusDeps["prisma"];
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const prisma = {
    backgroundJob: {
      findFirst: async (args: RecordedCall) => {
        calls.push(args);
        return row;
      },
    },
  } as unknown as GetJobStatusDeps["prisma"];
  return { prisma, calls };
}

describe("getJobStatus — ownership scoping (real fn, injected prisma)", () => {
  it("scopes the lookup to BOTH jobId AND the caller userId", async () => {
    const { prisma, calls } = fakePrisma({ jobId: "j1" });
    await getJobStatus("user_1", "j1", { prisma });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.where, { jobId: "j1", userId: "user_1" });
  });

  it("selects only the payload-free status whitelist (never `payload`)", async () => {
    const { prisma, calls } = fakePrisma(null);
    await getJobStatus("user_1", "j1", { prisma });
    const select = calls[0]?.select as Record<string, unknown>;
    assert.equal(select.payload, undefined); // payload never selected
    assert.equal(select.jobId, true);
    assert.equal(select.status, true);
    assert.equal(select.result, true);
  });

  it("returns the job on a hit", async () => {
    const row = {
      jobId: "j1",
      jobType: "BROKER_SYNC",
      status: "PROCESSING",
      progress: 42,
      result: null,
      errorMessage: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    };
    const { prisma } = fakePrisma(row);
    const res = await getJobStatus("user_1", "j1", { prisma });
    assert.equal(res.success, true);
    if (res.success) assert.equal(res.data.status, "PROCESSING");
  });

  it("returns a not-found result when the row is null (not owned / absent → 404)", async () => {
    const { prisma } = fakePrisma(null);
    const res = await getJobStatus("attacker", "victims_job", { prisma });
    assert.equal(res.success, false);
    if (!res.success) {
      assert.equal(res.error, "Job not found");
      // code distinguishes a genuine not-found (route → 404) from a DB error.
      assert.equal(res.code, "NOT_FOUND");
    }
  });

  it("fails closed with a sanitised error when the query throws", async () => {
    const prisma = {
      backgroundJob: {
        findFirst: async () => {
          throw new Error("Mongo connection refused");
        },
      },
    } as unknown as GetJobStatusDeps["prisma"];
    const res = await getJobStatus("user_1", "j1", { prisma });
    assert.equal(res.success, false);
    if (!res.success) {
      // Internal DB error is sanitised — never leaked to the caller.
      assert.equal(res.error, "Failed to fetch job status");
      // code "INTERNAL" makes the route return a retryable 500 (not a 404 that
      // would tell the client the job vanished and stop it polling).
      assert.equal(res.code, "INTERNAL");
    }
  });
});
