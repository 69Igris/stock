/**
 * MONEY-620 — import-job server actions END-TO-END (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-declared job-id generation, progress
 * clamping, the status→ImportJobStatus mapping, active-job filtering and error
 * extraction — then asserted the COPIES, importing NOTHING from
 * `lib/actions/import-job.ts`. So the real gates never ran on the shipping code:
 * the auth gate (`getOrCreateUser` returning null without a clerk email), the
 * IDOR scoping (`getJobForUser(jobId, user.id)` / `getUserJobs(user.id, …)`), the
 * "result only when COMPLETED" exposure gate, the worker Pub/Sub offload carrying
 * the CALLER userId, and `getSafeErrorMessage` sanitization of a thrown step.
 *
 * This rewrite drives the REAL exported actions through the `require.cache` seam.
 * `@usemoney/utils/error-sanitization` and `@usemoney/types` are kept REAL (genuine
 * sanitization + topic naming). We stub `@clerk/nextjs/server`,
 * `@usemoney/database`, `@/lib/jobs/job-service`, `@/lib/jobs/import-processor`,
 * `@usemoney/pubsub/publish`. Assertions target the action's OWN logic:
 *   - every action: no clerk email → "Unauthorized", no job created.
 *   - startImportJobAction: creates the job + publishes the worker job under the
 *     CALLER user.id (IDOR); the payload stores contentLength, NOT the raw
 *     content (size-safety contract); a thrown createJob → sanitized error.
 *   - getImportJobStatusAction: forwards (jobId, user.id) (IDOR); a not-owned job
 *     → "Job not found"; a non-COMPLETED job hides its `result`.
 *   - getImportJobsAction / getActiveImportJobsAction: scoped to the caller
 *     user.id; active filter keeps only PENDING/PROCESSING.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/import-job.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface PrismaCall {
  model: string;
  method: string;
  args: unknown;
}
interface JobServiceCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  clerkUserId: string | null;
  clerkUser: {
    emailAddresses?: Array<{ emailAddress: string }>;
    fullName?: string | null;
    firstName?: string | null;
  } | null;
  /** user.findFirst result; if null, a user.create is performed */
  userRow: { id: string; clerkId: string | null } | null;
  createJobThrows?: Error;
  jobForUser: Record<string, unknown> | null;
  userJobs: Array<Record<string, unknown>>;
  prismaCalls: PrismaCall[];
  jobServiceCalls: JobServiceCall[];
  publishCalls: unknown[];
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const ACTION_REL = "../../lib/actions/import-job";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface ImportJobModule {
  startImportJobAction: (o: {
    content: string;
    brokerFormat: string;
    fileType: "csv" | "xlsx";
    fileName?: string;
  }) => Promise<{ success: boolean; jobId?: string; error?: string }>;
  getImportJobStatusAction: (jobId: string) => Promise<{
    success: boolean;
    job?: Record<string, unknown>;
    error?: string;
  }>;
  getImportJobsAction: (o?: { limit?: number; status?: string }) => Promise<{
    success: boolean;
    jobs?: Array<Record<string, unknown>>;
    error?: string;
  }>;
  getActiveImportJobsAction: () => Promise<{
    success: boolean;
    jobs?: Array<Record<string, unknown>>;
    error?: string;
  }>;
}

function freshHarness(): Harness {
  return {
    clerkUserId: "clerk_abc",
    clerkUser: {
      emailAddresses: [{ emailAddress: "u@x.com" }],
      fullName: "Test User",
    },
    userRow: { id: "internal-user-1", clerkId: "clerk_abc" },
    jobForUser: null,
    userJobs: [],
    prismaCalls: [],
    jobServiceCalls: [],
    publishCalls: [],
  };
}

function makeRecordingPrisma(h: Harness): unknown {
  return {
    user: {
      findFirst: (args: unknown) => {
        h.prismaCalls.push({ model: "user", method: "findFirst", args });
        return Promise.resolve(h.userRow);
      },
      create: (args: unknown) => {
        h.prismaCalls.push({ model: "user", method: "create", args });
        return Promise.resolve({ id: "internal-user-1", clerkId: "clerk_abc" });
      },
      update: (args: unknown) => {
        h.prismaCalls.push({ model: "user", method: "update", args });
        return Promise.resolve({ id: "internal-user-1", clerkId: "clerk_abc" });
      },
    },
    backgroundJob: {
      update: (args: unknown) => {
        h.prismaCalls.push({
          model: "backgroundJob",
          method: "update",
          args,
        });
        return Promise.resolve({});
      },
    },
  };
}

function loadAction(h: Harness): ImportJobModule {
  const cache = moduleCache();

  const clerkPath = require.resolve("@clerk/nextjs/server");
  const dbPath = require.resolve("@usemoney/database");
  const jobSvcPath = require.resolve("../../lib/jobs/job-service");
  const procPath = require.resolve("../../lib/jobs/import-processor");
  const pubsubPath = require.resolve("@usemoney/pubsub/publish");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [clerkPath, dbPath, jobSvcPath, procPath, pubsubPath]) {
    snapshotOnce(p);
  }

  cache[clerkPath] = {
    exports: {
      __esModule: true,
      auth: () => Promise.resolve({ userId: h.clerkUserId }),
      currentUser: () => Promise.resolve(h.clerkUser),
    },
  };
  cache[dbPath] = {
    exports: { __esModule: true, prisma: makeRecordingPrisma(h) },
  };
  cache[jobSvcPath] = {
    exports: {
      __esModule: true,
      createJob: (...args: unknown[]) => {
        h.jobServiceCalls.push({ fn: "createJob", args });
        if (h.createJobThrows) return Promise.reject(h.createJobThrows);
        return Promise.resolve("job-id-1");
      },
      getJobForUser: (...args: unknown[]) => {
        h.jobServiceCalls.push({ fn: "getJobForUser", args });
        return Promise.resolve(h.jobForUser);
      },
      getUserJobs: (...args: unknown[]) => {
        h.jobServiceCalls.push({ fn: "getUserJobs", args });
        return Promise.resolve(h.userJobs);
      },
    },
  };
  cache[procPath] = {
    exports: {
      __esModule: true,
      processImportJob: () => Promise.resolve({ success: true }),
    },
  };
  cache[pubsubPath] = {
    exports: {
      __esModule: true,
      publishImportJob: (args: unknown) => {
        h.publishCalls.push(args);
        return Promise.resolve("pub-msg-id");
      },
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as ImportJobModule;
}

function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-id-1",
    status: "COMPLETED",
    progress: 100,
    result: { imported: 5, stage: "done" },
    errorMessage: null,
    queuedAt: new Date("2026-02-01T00:00:00Z"),
    startedAt: new Date("2026-02-01T00:01:00Z"),
    completedAt: new Date("2026-02-01T00:02:00Z"),
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — import-job actions (real handlers, real sanitization, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("auth gate (no clerk email → Unauthorized)", () => {
    it("startImportJobAction → Unauthorized, no job created", async () => {
      h.clerkUser = { emailAddresses: [] }; // no email
      const action = loadAction(h);
      const res = await action.startImportJobAction({
        content: "a,b\n1,2",
        brokerFormat: "zerodha",
        fileType: "csv",
      });
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.jobServiceCalls.length, 0);
      assert.equal(h.publishCalls.length, 0);
    });

    it("getImportJobStatusAction → Unauthorized, no job lookup", async () => {
      h.clerkUserId = null;
      const action = loadAction(h);
      const res = await action.getImportJobStatusAction("job-1");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /Unauthorized/);
      assert.equal(h.jobServiceCalls.length, 0);
    });
  });

  describe("startImportJobAction", () => {
    it("creates the job + publishes the worker job under the CALLER user.id (IDOR)", async () => {
      const action = loadAction(h);
      const res = await action.startImportJobAction({
        content: "a,b\n1,2",
        brokerFormat: "zerodha",
        fileType: "csv",
        fileName: "trades.csv",
      });
      assert.equal(res.success, true);
      assert.equal(res.jobId, "job-id-1");
      const create = h.jobServiceCalls.find((c) => c.fn === "createJob");
      assert.equal(
        (create!.args[0] as { userId: string }).userId,
        "internal-user-1"
      );
      const pub = h.publishCalls[0] as { userId: string; content: string };
      assert.equal(pub.userId, "internal-user-1");
      assert.equal(pub.content, "a,b\n1,2");
    });

    it("the job payload stores contentLength, NOT the raw content (size-safety)", async () => {
      const action = loadAction(h);
      await action.startImportJobAction({
        content: "x".repeat(1234),
        brokerFormat: "zerodha",
        fileType: "csv",
      });
      const create = h.jobServiceCalls.find((c) => c.fn === "createJob");
      const payload = (create!.args[0] as { payload: Record<string, unknown> })
        .payload;
      assert.equal(payload.contentLength, 1234);
      assert.equal(
        "content" in payload,
        false,
        "raw content must NOT be stored in the job payload"
      );
    });

    it("a thrown createJob → sanitized error (no internal leak)", async () => {
      h.createJobThrows = new Error("ECONNREFUSED 10.0.0.5 mongo");
      const action = loadAction(h);
      const res = await action.startImportJobAction({
        content: "a,b\n1,2",
        brokerFormat: "zerodha",
        fileType: "csv",
      });
      assert.equal(res.success, false);
      assert.ok(!/10\.0\.0\.5/.test(res.error ?? ""), res.error);
    });
  });

  describe("getImportJobStatusAction", () => {
    it("IDOR: forwards (jobId, user.id); a not-owned job → 'Job not found'", async () => {
      h.jobForUser = null;
      const action = loadAction(h);
      const res = await action.getImportJobStatusAction("someone-elses-job");
      assert.equal(res.success, false);
      assert.match(res.error ?? "", /not found/i);
      const call = h.jobServiceCalls.find((c) => c.fn === "getJobForUser");
      assert.deepEqual(call!.args, ["someone-elses-job", "internal-user-1"]);
    });

    it("a COMPLETED job exposes its result", async () => {
      h.jobForUser = jobRow({ status: "COMPLETED" });
      const action = loadAction(h);
      const res = await action.getImportJobStatusAction("job-id-1");
      assert.equal(res.success, true);
      assert.ok(res.job!.result, "COMPLETED must expose result");
      assert.equal((res.job!.result as { imported: number }).imported, 5);
    });

    it("a PROCESSING job HIDES its result (exposure gate)", async () => {
      h.jobForUser = jobRow({ status: "PROCESSING", progress: 40 });
      const action = loadAction(h);
      const res = await action.getImportJobStatusAction("job-id-1");
      assert.equal(res.success, true);
      assert.equal(
        res.job!.result,
        undefined,
        "non-COMPLETED must not expose result"
      );
      // But the progress + stage are surfaced from the in-flight result.
      assert.equal(res.job!.progress, 40);
      assert.equal(res.job!.stage, "done");
    });
  });

  describe("getImportJobsAction / getActiveImportJobsAction", () => {
    it("getImportJobsAction: scoped to the caller user.id with CSV_IMPORT type", async () => {
      h.userJobs = [jobRow()];
      const action = loadAction(h);
      const res = await action.getImportJobsAction({ limit: 10 });
      assert.equal(res.success, true);
      const call = h.jobServiceCalls.find((c) => c.fn === "getUserJobs");
      assert.equal(call!.args[0], "internal-user-1");
      assert.equal(
        (call!.args[1] as { jobType: string }).jobType,
        "CSV_IMPORT"
      );
    });

    it("getActiveImportJobsAction: keeps only PENDING/PROCESSING", async () => {
      h.userJobs = [
        jobRow({ jobId: "a", status: "PENDING" }),
        jobRow({ jobId: "b", status: "COMPLETED" }),
        jobRow({ jobId: "c", status: "PROCESSING" }),
        jobRow({ jobId: "d", status: "FAILED" }),
      ];
      const action = loadAction(h);
      const res = await action.getActiveImportJobsAction();
      assert.equal(res.success, true);
      const ids = res.jobs!.map((j) => j.jobId).sort();
      assert.deepEqual(ids, ["a", "c"]);
    });
  });
});
