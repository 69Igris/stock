/**
 * Studio cost guardrail (MONEY-633) — daily-limit resolution + fail-open behaviour.
 * Pure/deterministic: dailyLimit() is env-only; checkDailyLimit is exercised on the
 * no-Redis path (REDIS_URL deleted) so it never opens a socket (no orphaned handles).
 *
 * Source under test: apps/content/lib/studio-rate-limit.ts
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { dailyLimit, checkDailyLimit } from "@/lib/studio-rate-limit";

describe("dailyLimit", () => {
  beforeEach(() => {
    delete process.env.STUDIO_IMAGE_DAILY_LIMIT;
    delete process.env.STUDIO_REEL_DAILY_LIMIT;
  });

  test("defaults: 50 images, 10 reels", () => {
    assert.equal(dailyLimit("image"), 50);
    assert.equal(dailyLimit("reel"), 10);
  });

  test("env override", () => {
    process.env.STUDIO_IMAGE_DAILY_LIMIT = "5";
    process.env.STUDIO_REEL_DAILY_LIMIT = "2";
    assert.equal(dailyLimit("image"), 5);
    assert.equal(dailyLimit("reel"), 2);
  });

  test("invalid / non-positive env falls back to default", () => {
    process.env.STUDIO_IMAGE_DAILY_LIMIT = "abc";
    assert.equal(dailyLimit("image"), 50);
    process.env.STUDIO_REEL_DAILY_LIMIT = "-3";
    assert.equal(dailyLimit("reel"), 10);
    process.env.STUDIO_REEL_DAILY_LIMIT = "0";
    assert.equal(dailyLimit("reel"), 10);
  });
});

describe("checkDailyLimit (fail-open without Redis)", () => {
  beforeEach(() => {
    delete process.env.STUDIO_IMAGE_DAILY_LIMIT;
    delete process.env.STUDIO_REEL_DAILY_LIMIT;
    delete process.env.REDIS_URL;
  });

  test("no REDIS_URL → ok:true (it's a cost guardrail, not auth)", async () => {
    const r = await checkDailyLimit("user_1", "image");
    assert.equal(r.ok, true);
    assert.equal(r.used, 0);
    assert.equal(r.limit, 50);
  });

  test("reports the resolved limit for the action", async () => {
    process.env.STUDIO_REEL_DAILY_LIMIT = "3";
    const r = await checkDailyLimit("user_1", "reel");
    assert.equal(r.ok, true);
    assert.equal(r.limit, 3);
  });
});
