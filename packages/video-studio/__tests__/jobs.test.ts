/**
 * Render job contract (MONEY-633) — the single Zod source of truth shared by the
 * enqueuer (apps/content) and the consumer (workers). Pure/deterministic.
 *
 * Source under test: packages/video-studio/src/jobs.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  RenderJob,
  JobStatus,
  JobState,
  RENDER_TOPIC,
  jobStatusKey,
} from "../src/jobs";

describe("jobs constants", () => {
  test("RENDER_TOPIC + jobStatusKey", () => {
    assert.equal(RENDER_TOPIC, "studio-render");
    assert.equal(jobStatusKey("abc"), "studio:render:abc");
  });

  test("JobState options", () => {
    assert.deepEqual(JobState.options, ["queued", "running", "done", "error"]);
  });
});

describe("RenderJob (discriminated union)", () => {
  test("render-reel parses with a valid timeline", () => {
    const job = RenderJob.parse({
      type: "render-reel",
      jobId: "j1",
      userId: "u1",
      timeline: { title: "t", scenes: [{ id: "s0", type: "hook" }] },
    });
    assert.equal(job.type, "render-reel");
    if (job.type === "render-reel") assert.equal(job.timeline.scenes.length, 1);
  });

  test("veo-clip applies aspect + duration defaults", () => {
    const job = RenderJob.parse({
      type: "veo-clip",
      jobId: "j2",
      userId: "u1",
      prompt: "abstract emerald light",
    });
    assert.equal(job.type, "veo-clip");
    if (job.type === "veo-clip") {
      assert.equal(job.aspect, "9:16");
      assert.equal(job.durationSec, 6);
    }
  });

  test("rejects unknown type", () => {
    assert.throws(() =>
      RenderJob.parse({ type: "nope", jobId: "x", userId: "u" }),
    );
  });

  test("rejects veo-clip missing required fields", () => {
    assert.throws(() => RenderJob.parse({ type: "veo-clip", jobId: "x" }));
  });
});

describe("JobStatus", () => {
  test("parses + defaults progress to 0", () => {
    const s = JobStatus.parse({
      jobId: "j",
      userId: "u",
      type: "render-reel",
      state: "queued",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    assert.equal(s.progress, 0);
    assert.equal(s.state, "queued");
  });

  test("rejects bad state", () => {
    assert.throws(() =>
      JobStatus.parse({
        jobId: "j",
        userId: "u",
        type: "x",
        state: "weird",
        updatedAt: "t",
      }),
    );
  });

  test("rejects out-of-range progress", () => {
    assert.throws(() =>
      JobStatus.parse({
        jobId: "j",
        userId: "u",
        type: "x",
        state: "done",
        progress: 150,
        updatedAt: "t",
      }),
    );
  });
});
