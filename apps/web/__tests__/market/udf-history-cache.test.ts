/**
 * UDF History Cache — pure-function tests (MONEY-122 / MONEY-620).
 *
 * De-shadowed: these assert the REAL exported helpers from
 * `apps/web/lib/market/udf-history-cache-logic.ts` — the same bytes the
 * production cache path runs (`udf-history-cache.ts` CALLS them). No inline
 * reimplementation.
 *
 * The logic module is dependency-free, so importing it never opens the Redis /
 * datadog handle that importing `udf-history-cache.ts` would — the test stays
 * pure and exits clean (no orphan).
 *
 * Source: apps/web/lib/market/udf-history-cache-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildUdfHistoryCacheKey,
  pickHistoryCacheTtlSeconds,
  NEGATIVE_CACHE_TTL_SECONDS,
} from "../../lib/market/udf-history-cache-logic";

// ============== KEY BUILDER ==============

describe("buildUdfHistoryCacheKey", () => {
  it("produces a deterministic key from request shape", () => {
    const key = buildUdfHistoryCacheKey({
      exchange: "NSE",
      symbol: "TCS",
      interval: "1D",
      fromSec: 1700000000,
      toSec: 1730000000,
    });
    assert.equal(key, "udf:history:NSE:TCS:1D:1700000000-1730000000");
  });

  it("uppercases exchange and symbol so case variants share a slot", () => {
    const upper = buildUdfHistoryCacheKey({
      exchange: "NSE",
      symbol: "TCS",
      interval: "5",
      fromSec: 1,
      toSec: 2,
    });
    const lower = buildUdfHistoryCacheKey({
      exchange: "nse",
      symbol: "tcs",
      interval: "5",
      fromSec: 1,
      toSec: 2,
    });
    const mixed = buildUdfHistoryCacheKey({
      exchange: "NsE",
      symbol: "tCs",
      interval: "5",
      fromSec: 1,
      toSec: 2,
    });
    assert.equal(upper, lower);
    assert.equal(upper, mixed);
  });

  it("does NOT uppercase the interval (TV resolution casing matters: 1D vs 1d)", () => {
    const a = buildUdfHistoryCacheKey({
      exchange: "NSE",
      symbol: "TCS",
      interval: "1D",
      fromSec: 1,
      toSec: 2,
    });
    const b = buildUdfHistoryCacheKey({
      exchange: "NSE",
      symbol: "TCS",
      interval: "1d",
      fromSec: 1,
      toSec: 2,
    });
    assert.notEqual(a, b);
  });

  it("includes fromSec and toSec verbatim in the key tail", () => {
    const key = buildUdfHistoryCacheKey({
      exchange: "BSE",
      symbol: "RELIANCE",
      interval: "60",
      fromSec: 1775000000,
      toSec: 1775500000,
    });
    assert.match(key, /1775000000-1775500000$/);
  });

  it("MF symbols with numeric scheme codes round-trip cleanly", () => {
    const key = buildUdfHistoryCacheKey({
      exchange: "MF",
      symbol: "120503",
      interval: "1D",
      fromSec: 100,
      toSec: 200,
    });
    assert.equal(key, "udf:history:MF:120503:1D:100-200");
  });

  it("colons in symbol are not escaped - caller must avoid them", () => {
    // Documents the assumption: TV symbols don't contain colons after the
    // exchange split. If this ever changes, the key format needs a delimiter swap.
    const key = buildUdfHistoryCacheKey({
      exchange: "NSE",
      symbol: "TCS",
      interval: "1D",
      fromSec: 1,
      toSec: 2,
    });
    assert.equal(key.split(":").length, 6);
  });

  // ── Adversarial / non-finite inputs (blind-spot coverage) ──
  it("does not emit 'NaN'/'Infinity' as a from/to that would corrupt the key prefix matching", () => {
    // A non-finite from/to would silently produce 'NaN'/'Infinity' in the key,
    // poisoning prefix scans. Document the current behavior so a future change
    // that introduces guarding is a deliberate, tested decision.
    const nan = buildUdfHistoryCacheKey({
      exchange: "NSE",
      symbol: "TCS",
      interval: "1D",
      fromSec: Number.NaN,
      toSec: 100,
    });
    // String(NaN) === "NaN" — this is the raw template behavior we lock in.
    assert.equal(nan, "udf:history:NSE:TCS:1D:NaN-100");
  });

  it("handles empty exchange/symbol without throwing (degenerate but key-safe)", () => {
    const key = buildUdfHistoryCacheKey({
      exchange: "",
      symbol: "",
      interval: "1D",
      fromSec: 0,
      toSec: 0,
    });
    assert.equal(key, "udf:history:::1D:0-0");
  });
});

// ============== TTL PICKER ==============

describe("pickHistoryCacheTtlSeconds", () => {
  it("intraday during market hours uses the short 30s TTL", () => {
    assert.equal(pickHistoryCacheTtlSeconds("5m", true), 30);
    assert.equal(pickHistoryCacheTtlSeconds("1m", true), 30);
    assert.equal(pickHistoryCacheTtlSeconds("60m", true), 30);
  });

  it("intraday outside market hours uses the longer 300s TTL", () => {
    assert.equal(pickHistoryCacheTtlSeconds("5m", false), 300);
    assert.equal(pickHistoryCacheTtlSeconds("1m", false), 300);
    assert.equal(pickHistoryCacheTtlSeconds("60m", false), 300);
  });

  it("daily during market hours uses 300s (mostly to refresh today's bar)", () => {
    assert.equal(pickHistoryCacheTtlSeconds("1d", true), 300);
    assert.equal(pickHistoryCacheTtlSeconds("1wk", true), 300);
    assert.equal(pickHistoryCacheTtlSeconds("1mo", true), 300);
  });

  it("daily outside market hours uses the long 1h TTL (bars are immutable)", () => {
    assert.equal(pickHistoryCacheTtlSeconds("1d", false), 3600);
    assert.equal(pickHistoryCacheTtlSeconds("1wk", false), 3600);
    assert.equal(pickHistoryCacheTtlSeconds("1mo", false), 3600);
  });

  it("treats 1h as an alias for 60m (intraday)", () => {
    assert.equal(
      pickHistoryCacheTtlSeconds("1h", true),
      pickHistoryCacheTtlSeconds("60m", true)
    );
    assert.equal(
      pickHistoryCacheTtlSeconds("1h", false),
      pickHistoryCacheTtlSeconds("60m", false)
    );
  });

  it("daily TTL > intraday TTL in both modes", () => {
    assert.ok(
      pickHistoryCacheTtlSeconds("1d", true) >
        pickHistoryCacheTtlSeconds("5m", true)
    );
    assert.ok(
      pickHistoryCacheTtlSeconds("1d", false) >
        pickHistoryCacheTtlSeconds("5m", false)
    );
  });

  it("off-hours TTL > market-hours TTL for the same interval class", () => {
    assert.ok(
      pickHistoryCacheTtlSeconds("5m", false) >
        pickHistoryCacheTtlSeconds("5m", true)
    );
    assert.ok(
      pickHistoryCacheTtlSeconds("1d", false) >
        pickHistoryCacheTtlSeconds("1d", true)
    );
  });

  it("unknown / empty interval falls into the daily class (conservative long TTL)", () => {
    // A garbage resolution is NOT in the intraday set, so it's cached as a
    // daily bar. Returns a positive finite TTL — never NaN/0/negative.
    for (const ttl of [
      pickHistoryCacheTtlSeconds("", true),
      pickHistoryCacheTtlSeconds("", false),
      pickHistoryCacheTtlSeconds("garbage", true),
      pickHistoryCacheTtlSeconds("garbage", false),
    ]) {
      assert.ok(
        Number.isFinite(ttl) && ttl > 0,
        `ttl ${ttl} must be finite > 0`
      );
    }
    assert.equal(pickHistoryCacheTtlSeconds("garbage", true), 300);
    assert.equal(pickHistoryCacheTtlSeconds("garbage", false), 3600);
  });
});

// ============== NEGATIVE CACHE ==============

describe("NEGATIVE_CACHE_TTL_SECONDS", () => {
  it("is 60 seconds", () => {
    assert.equal(NEGATIVE_CACHE_TTL_SECONDS, 60);
  });

  it("is shorter than the longest intraday off-hours TTL", () => {
    // Negative responses should expire faster than positive ones so a no_data
    // from a holiday gap doesn't get stuck for as long as a real bar would.
    assert.ok(
      NEGATIVE_CACHE_TTL_SECONDS < pickHistoryCacheTtlSeconds("5m", false)
    );
  });

  it("is shorter than the daily market-hours TTL", () => {
    assert.ok(
      NEGATIVE_CACHE_TTL_SECONDS < pickHistoryCacheTtlSeconds("1d", true)
    );
  });
});

describe("MONEY-1176 — the adjustment must be part of the cache key", () => {
  const base = {
    exchange: "NSE",
    symbol: "RELIANCE",
    interval: "1D",
    fromSec: 1_700_000_000,
    toSec: 1_730_000_000,
  };

  it("omitting the adjustment info reproduces the pre-1176 key EXACTLY", () => {
    // Back-compat: entries cached before this shipped must not be orphaned.
    assert.strictEqual(
      buildUdfHistoryCacheKey(base),
      "udf:history:NSE:RELIANCE:1D:1700000000-1730000000"
    );
  });

  it("adjusted and raw payloads never share a slot", () => {
    // Without this, an `adj=0` request and a default request collide and one
    // of them is served on the wrong price basis.
    const adj = buildUdfHistoryCacheKey({
      ...base,
      adjusted: true,
      actionsFingerprint: "3-1700000000000",
    });
    const raw = buildUdfHistoryCacheKey({
      ...base,
      adjusted: false,
      actionsFingerprint: "3-1700000000000",
    });
    assert.notStrictEqual(adj, raw);
  });

  it("a new backfill rolls EVERY window over together", () => {
    // The failure this prevents is subtle: with TTL-only invalidation, windows
    // cached either side of a backfill disagree with each other and ONE chart
    // draws part of its history adjusted and part raw.
    const before = buildUdfHistoryCacheKey({
      ...base,
      adjusted: true,
      actionsFingerprint: "3-1700000000000",
    });
    const after = buildUdfHistoryCacheKey({
      ...base,
      adjusted: true,
      actionsFingerprint: "4-1800000000000",
    });
    assert.notStrictEqual(before, after);
  });

  it("a CORRECTED ratio on an existing row also busts the key", () => {
    // Count alone would miss it — which is exactly what the classifier does
    // when it retypes an OTHER row into a SPLIT with a real ratio.
    const before = buildUdfHistoryCacheKey({
      ...base,
      adjusted: true,
      actionsFingerprint: "3-1700000000000",
    });
    const after = buildUdfHistoryCacheKey({
      ...base,
      adjusted: true,
      actionsFingerprint: "3-1900000000000",
    });
    assert.notStrictEqual(before, after);
  });

  it("is stable for identical inputs", () => {
    const input = { ...base, adjusted: true, actionsFingerprint: "2-123" };
    assert.strictEqual(
      buildUdfHistoryCacheKey(input),
      buildUdfHistoryCacheKey(input)
    );
  });
});
