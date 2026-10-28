/**
 * The ephemeral interest ping must never throw — MONEY-1309.
 *
 * `pingUsSymbolInterest` is called from a SERVER COMPONENT RENDER. It exists so
 * the socket holder learns that somebody is looking at `AAPL` and subscribes to
 * it; the worst thing a failure can cost is one page view its live quote. So the
 * one property that actually matters is negative — it must resolve rather than
 * reject, no matter what Redis does — and a negative property is exactly the
 * kind that passes vacuously if the test never reaches the code.
 *
 * Hence a RECORDING fake injected through `__setRedisFactoryForTests` (the same
 * harness `cache-batch-ops.test.ts` uses), and a `throwOnEveryCommand` mode: the
 * happy-path cases prove the commands are actually issued, and the hostile case
 * proves they can all fail without a rejection escaping. Testing only the happy
 * path here would leave the guarantee unmeasured.
 *
 * The COMMANDS are asserted too, and they are not decoration:
 *   - the score must be an EXPIRY (`now + TTL`), because the eviction policy
 *     drops the soonest-expiring first, which is a range query on the score;
 *   - the prune (`ZREMRANGEBYSCORE … -inf now`) must run BEFORE the add, so an
 *     idle set does not carry dead members into that arithmetic.
 *
 * Source: packages/core/src/market-data/tiingo/tiingo-rt-read.ts
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Redis } from "ioredis";

import {
  __setRedisFactoryForTests,
  resetRedisClient,
} from "../../src/cache/redis";
import { RT_EPHEMERAL_SET_KEY } from "../../src/market-data/tiingo/tiingo-rt-keys";
import { RT_EPHEMERAL_TTL_MS } from "../../src/market-data/tiingo/tiingo-rt-read-logic";
import { pingUsSymbolInterest } from "../../src/market-data/tiingo/tiingo-rt-read";

const NOW = Date.UTC(2026, 7, 31, 18, 0, 0);

interface Recorder {
  calls: Array<{ cmd: string; args: unknown[] }>;
}

function installFakeRedis(opts: { throwOnEveryCommand?: boolean } = {}): {
  rec: Recorder;
  uninstall: () => void;
} {
  const rec: Recorder = { calls: [] };
  const boom = () => {
    if (opts.throwOnEveryCommand) throw new Error("redis unavailable");
  };

  const client = {
    status: "ready",
    on() {
      return client;
    },
    async zadd(...args: unknown[]) {
      rec.calls.push({ cmd: "zadd", args });
      boom();
      return 1;
    },
    async zremrangebyscore(...args: unknown[]) {
      rec.calls.push({ cmd: "zremrangebyscore", args });
      boom();
      return 0;
    },
    async mget(...keys: string[]) {
      rec.calls.push({ cmd: "mget", args: keys });
      boom();
      return keys.map(() => null);
    },
    async quit() {
      return "OK";
    },
    disconnect() {},
  };

  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = "redis://fake-m1309-interest:6379";
  __setRedisFactoryForTests(() => client as unknown as Redis);
  resetRedisClient();

  return {
    rec,
    uninstall: () => {
      resetRedisClient();
      __setRedisFactoryForTests(null);
      if (previousUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousUrl;
    },
  };
}

/** No Redis configured at all — the local-dev / misconfigured-env shape. */
function installNoRedis(): { uninstall: () => void } {
  const previousUrl = process.env.REDIS_URL;
  const previousHost = process.env.REDIS_HOST;
  const previousUpstash = process.env.UPSTASH_REDIS_REST_URL;
  const previousKv = process.env.KV_URL;
  delete process.env.REDIS_URL;
  delete process.env.REDIS_HOST;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_URL;
  resetRedisClient();
  return {
    uninstall: () => {
      resetRedisClient();
      if (previousUrl !== undefined) process.env.REDIS_URL = previousUrl;
      if (previousHost !== undefined) process.env.REDIS_HOST = previousHost;
      if (previousUpstash !== undefined) {
        process.env.UPSTASH_REDIS_REST_URL = previousUpstash;
      }
      if (previousKv !== undefined) process.env.KV_URL = previousKv;
    },
  };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("pingUsSymbolInterest (MONEY-1309)", () => {
  it("[meta] the fake is reached at all — the negative cases are not vacuous", () => {
    const { rec, uninstall } = installFakeRedis();
    cleanup = uninstall;
    return pingUsSymbolInterest(["AAPL"], { now: NOW }).then((ok) => {
      assert.equal(ok, true, "a healthy Redis should report the ping landed");
      assert.ok(
        rec.calls.length >= 2,
        `expected a prune and an add; saw ${rec.calls.length} commands`,
      );
    });
  });

  it("scores members by EXPIRY, uppercased, on the ephemeral set key", async () => {
    const { rec, uninstall } = installFakeRedis();
    cleanup = uninstall;

    await pingUsSymbolInterest([" aapl ", "msft"], { now: NOW });

    const add = rec.calls.find((c) => c.cmd === "zadd");
    assert.ok(add, "no ZADD issued");
    assert.equal(add.args[0], RT_EPHEMERAL_SET_KEY);
    // score, member, score, member — the sliding-window score is `now + TTL`.
    assert.deepEqual(add.args.slice(1), [
      NOW + RT_EPHEMERAL_TTL_MS,
      "AAPL",
      NOW + RT_EPHEMERAL_TTL_MS,
      "MSFT",
    ]);
  });

  it("prunes expired members BEFORE adding", async () => {
    const { rec, uninstall } = installFakeRedis();
    cleanup = uninstall;

    await pingUsSymbolInterest(["AAPL"], { now: NOW });

    const pruneIdx = rec.calls.findIndex((c) => c.cmd === "zremrangebyscore");
    const addIdx = rec.calls.findIndex((c) => c.cmd === "zadd");
    assert.ok(pruneIdx >= 0, "no ZREMRANGEBYSCORE issued");
    assert.ok(
      pruneIdx < addIdx,
      "the prune must run first, or a set that has been idle carries dead " +
        "members into the eviction arithmetic",
    );
    assert.deepEqual(rec.calls[pruneIdx]!.args, [
      RT_EPHEMERAL_SET_KEY,
      "-inf",
      NOW,
    ]);
  });

  it("de-duplicates and drops blanks rather than writing junk members", async () => {
    const { rec, uninstall } = installFakeRedis();
    cleanup = uninstall;

    await pingUsSymbolInterest(["AAPL", "aapl", "", "   "], { now: NOW });

    const add = rec.calls.find((c) => c.cmd === "zadd");
    assert.ok(add);
    assert.deepEqual(add.args.slice(1), [NOW + RT_EPHEMERAL_TTL_MS, "AAPL"]);
  });

  it("RESOLVES FALSE when every Redis command throws — never rejects", async () => {
    const { rec, uninstall } = installFakeRedis({ throwOnEveryCommand: true });
    cleanup = uninstall;

    // Deliberately NOT `assert.rejects`/`doesNotReject` around a bare call: the
    // claim is that the returned promise settles to `false`, which is stronger
    // and also proves the caller can branch on the outcome.
    const ok = await pingUsSymbolInterest(["AAPL"], { now: NOW });
    assert.equal(ok, false);
    assert.ok(
      rec.calls.length > 0,
      "the throwing client was never reached — this case proved nothing",
    );
  });

  it("resolves FALSE with no Redis configured at all", async () => {
    const { uninstall } = installNoRedis();
    cleanup = uninstall;
    assert.equal(await pingUsSymbolInterest(["AAPL"], { now: NOW }), false);
  });

  it("resolves FALSE for an empty symbol list without touching Redis", async () => {
    const { rec, uninstall } = installFakeRedis();
    cleanup = uninstall;
    assert.equal(await pingUsSymbolInterest([], { now: NOW }), false);
    assert.equal(rec.calls.length, 0);
  });
});
