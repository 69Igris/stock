/**
 * Cache Key — negative / edge-case tests (MONEY-620).
 *
 * Imports the REAL exported symbols from `@usemoney/cache`
 * (packages/cache/src/keys.ts) — NO inline reimplementation (no shadow).
 * The existing `keys.test.ts` only covers the happy paths of
 * `generateCacheKey` + `generateVersionHash`; this file adds:
 *   - `parseCacheKey`        (round-trip + every malformed shape) — untested before
 *   - `generateCachePattern` (real export; invalidation.test.ts shadows it)  — real-import here
 *   - `sanitizeUserId`       (logging truncation; never leak the full id) — untested before
 *   - collision / separator-injection / unicode / undefined-arg edges on the
 *     key + version-hash builders.
 *
 * Pure (crypto MD5 only) → exits clean, no orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateCacheKey,
  generateVersionHash,
  parseCacheKey,
  generateCachePattern,
  sanitizeUserId,
} from "@usemoney/cache";

describe("Cache keys — negative / edge cases", () => {
  // =========================================================================
  // parseCacheKey — untested before; the inverse of generateCacheKey
  // =========================================================================
  describe("parseCacheKey", () => {
    it("round-trips a key produced by generateCacheKey", () => {
      const key = generateCacheKey("dashboard", "user123", "stats");
      const parsed = parseCacheKey(key);
      assert.deepStrictEqual(parsed, {
        module: "dashboard",
        userId: "user123",
        identifier: "stats",
        version: "default",
      });
    });

    it("round-trips a versioned (hashed) key", () => {
      const key = generateCacheKey("positions", "u1", "list", { page: 2 });
      const parsed = parseCacheKey(key);
      assert.ok(parsed);
      assert.strictEqual(parsed.module, "positions");
      assert.strictEqual(parsed.userId, "u1");
      assert.strictEqual(parsed.identifier, "list");
      assert.match(parsed.version, /^[a-f0-9]{8}$/);
    });

    it("returns null for too few segments", () => {
      assert.strictEqual(parseCacheKey("dashboard:user123:stats"), null);
      assert.strictEqual(parseCacheKey("dashboard:user123"), null);
      assert.strictEqual(parseCacheKey("dashboard"), null);
      assert.strictEqual(parseCacheKey(""), null);
    });

    it("returns null for too many segments (extra colon)", () => {
      // A 5-part string must NOT silently parse — guards against a userId or
      // identifier that itself contains ':' being mis-split.
      assert.strictEqual(
        parseCacheKey("dashboard:user:123:stats:default"),
        null
      );
    });

    it("returns null when any segment is empty (leading/trailing/middle colon)", () => {
      assert.strictEqual(parseCacheKey(":user123:stats:default"), null);
      assert.strictEqual(parseCacheKey("dashboard::stats:default"), null);
      assert.strictEqual(parseCacheKey("dashboard:user123::default"), null);
      assert.strictEqual(parseCacheKey("dashboard:user123:stats:"), null);
    });
  });

  // =========================================================================
  // generateCacheKey / generateVersionHash — collision & injection edges
  // =========================================================================
  describe("generateCacheKey — collision & separator edges", () => {
    it("does NOT collide on (userId, identifier) pairs sharing a ':' boundary (task 139 fix)", () => {
      // REGRESSION (MONEY-620, task 139): generateCacheKey used to join parts with
      // a bare ':' and never escape a ':' inside userId/identifier, so ("a:b","c")
      // and ("a","b:c") both produced "dashboard:a:b:c:default" → two distinct
      // logical entries silently aliased (keyspace collision / cross-entry data
      // bleed). Segments are now reversibly escaped (':' → '%3A'), so the keys are
      // distinct and each round-trips back to its ORIGINAL segments.
      const k1 = generateCacheKey("dashboard", "a:b", "c");
      const k2 = generateCacheKey("dashboard", "a", "b:c");
      assert.notStrictEqual(k1, k2, "colon-bearing segments must not collide");

      const p1 = parseCacheKey(k1);
      const p2 = parseCacheKey(k2);
      assert.ok(p1 && p2);
      assert.strictEqual(p1.userId, "a:b");
      assert.strictEqual(p1.identifier, "c");
      assert.strictEqual(p2.userId, "a");
      assert.strictEqual(p2.identifier, "b:c");
    });

    it("escapes a literal '%' so it can't forge an escape sequence (round-trips)", () => {
      // A userId containing the literal text "%3A" must NOT decode to ':' — '%' is
      // escaped FIRST, so "%3A" stays "%3A" and does not collide with a real colon.
      const key = generateCacheKey("dashboard", "a%3Ab", "c");
      const parsed = parseCacheKey(key);
      assert.ok(parsed);
      assert.strictEqual(parsed.userId, "a%3Ab"); // intact, not turned into "a:b"
      assert.notStrictEqual(key, generateCacheKey("dashboard", "a:b", "c"));
    });

    it("a ':' in identifier no longer breaks parseCacheKey's 4-part contract", () => {
      // e.g. "RELIANCE:NSE": previously a 5-colon string parseCacheKey rejected as
      // malformed; the escaped form parses and round-trips cleanly.
      const key = generateCacheKey("holdings", "u1", "RELIANCE:NSE");
      const parsed = parseCacheKey(key);
      assert.ok(parsed, "colon-in-identifier key should parse");
      assert.strictEqual(parsed.identifier, "RELIANCE:NSE");
      assert.strictEqual(parsed.module, "holdings");
      assert.strictEqual(parsed.userId, "u1");
    });

    it("treats falsy version inputs (undefined) as the 'default' sentinel, not a hash", () => {
      assert.strictEqual(
        generateCacheKey("user", "u1", "profile", undefined),
        "user:u1:profile:default"
      );
    });

    it("hashes an explicitly-empty filters object (NOT 'default')", () => {
      // {} is truthy → it must hash, so an explicit empty-filter query never
      // aliases the no-filter ('default') cache entry.
      const key = generateCacheKey("trades", "u1", "list", {});
      const parsed = parseCacheKey(key);
      assert.ok(parsed);
      assert.notStrictEqual(parsed.version, "default");
      assert.match(parsed.version, /^[a-f0-9]{8}$/);
    });

    it("produces identical keys for different namespaces with empty-string ids (documents weak spot)", () => {
      // An empty userId/identifier yields odd keys; assert the observed behavior
      // so a future change that fixes/breaks it is caught.
      const key = generateCacheKey("dashboard", "", "");
      assert.strictEqual(key, "dashboard:::default");
      // ...and such a key is correctly rejected by the parser.
      assert.strictEqual(parseCacheKey(key), null);
    });

    it("keeps unicode userId / identifier intact in the key", () => {
      const key = generateCacheKey("holdings", "用户·🚀", "持仓");
      assert.ok(key.startsWith("holdings:用户·🚀:持仓:"));
      // parseCacheKey splits on ':' only, so unicode parts survive intact.
      const parsed = parseCacheKey(key);
      assert.ok(parsed);
      assert.strictEqual(parsed.userId, "用户·🚀");
      assert.strictEqual(parsed.identifier, "持仓");
    });
  });

  describe("generateVersionHash — adversarial inputs", () => {
    it("is deterministic and key-order-independent (collision-AVOIDANCE guarantee)", () => {
      const a = generateVersionHash({ a: 1, b: 2, c: 3 });
      const b = generateVersionHash({ c: 3, b: 2, a: 1 });
      assert.strictEqual(a, b);
    });

    it("distinguishes values that JSON-stringify to look-alike strings", () => {
      // number 1 vs string "1" — must NOT collide.
      const num = generateVersionHash({ x: 1 });
      const str = generateVersionHash({ x: "1" });
      assert.notStrictEqual(num, str);
    });

    it("distinguishes null from missing key", () => {
      const withNull = generateVersionHash({ x: null });
      const without = generateVersionHash({});
      assert.notStrictEqual(withNull, without);
    });

    it("handles unicode filter values without throwing and stays 8 hex chars", () => {
      const hash = generateVersionHash({ q: "रिलायंस 🚀 \u0000 null" });
      assert.match(hash, /^[a-f0-9]{8}$/);
    });

    it("handles a null top-level argument (Object.keys(null) guarded)", () => {
      // generateVersionHash(null): JSON.stringify(null, []) → "null". Must not
      // throw, and must produce a stable 8-hex hash.
      const h1 = generateVersionHash(null);
      const h2 = generateVersionHash(null);
      assert.match(h1, /^[a-f0-9]{8}$/);
      assert.strictEqual(h1, h2);
    });

    it("handles array filters and distinguishes order (arrays are ordered)", () => {
      const ab = generateVersionHash(["a", "b"]);
      const ba = generateVersionHash(["b", "a"]);
      assert.match(ab, /^[a-f0-9]{8}$/);
      assert.notStrictEqual(ab, ba);
    });
  });

  // =========================================================================
  // generateCachePattern — REAL export (invalidation.test.ts shadows it)
  // =========================================================================
  describe("generateCachePattern", () => {
    it("module-only → 'module:*'", () => {
      assert.strictEqual(generateCachePattern("dashboard"), "dashboard:*");
    });

    it("module + userId → 'module:userId:*'", () => {
      assert.strictEqual(
        generateCachePattern("dashboard", "user123"),
        "dashboard:user123:*"
      );
    });

    it("module + userId + identifier → 'module:userId:identifier:*'", () => {
      assert.strictEqual(
        generateCachePattern("fire", "user123", "scenario1"),
        "fire:user123:scenario1:*"
      );
    });

    it("ignores identifier when userId is absent (cannot build a sound pattern)", () => {
      // identifier without userId must fall back to module-only, NOT emit a
      // malformed 'module:identifier:*' that would wildcard the wrong segment.
      assert.strictEqual(
        generateCachePattern("fire", undefined, "scenario1"),
        "fire:*"
      );
    });

    it("a key matched by the user pattern is one this user actually owns", () => {
      // Glue test: the pattern derived for user A must prefix-match A's own key
      // and NOT user B's key (IDOR-style cross-user invalidation guard).
      const keyA = generateCacheKey("dashboard", "userA", "stats");
      const keyB = generateCacheKey("dashboard", "userB", "stats");
      const patternA = generateCachePattern("dashboard", "userA"); // dashboard:userA:*
      const prefixA = patternA.slice(0, -1); // strip trailing '*'
      assert.ok(keyA.startsWith(prefixA));
      assert.ok(!keyB.startsWith(prefixA));
    });
  });

  // =========================================================================
  // sanitizeUserId — untested before; must never leak the full id to logs
  // =========================================================================
  describe("sanitizeUserId", () => {
    it("truncates to the first 8 characters", () => {
      assert.strictEqual(sanitizeUserId("user_2abc123456789def"), "user_2ab");
    });

    it("returns a short id unchanged (no padding, no throw)", () => {
      assert.strictEqual(sanitizeUserId("abc"), "abc");
      assert.strictEqual(sanitizeUserId(""), "");
    });

    it("never returns more than 8 chars for a long id (no full-id leak)", () => {
      const long = "x".repeat(200);
      assert.strictEqual(sanitizeUserId(long).length, 8);
    });

    it("counts UTF-16 code units (does not split surrogate-pair awareness aside)", () => {
      // .slice(0,8) is code-unit based; assert observed behavior so emoji-laden
      // ids have predictable, bounded log output.
      const out = sanitizeUserId("🚀🚀🚀🚀🚀");
      // 5 rockets = 10 UTF-16 units; first 8 units = 4 full rockets.
      assert.strictEqual(out.length, 8);
      assert.strictEqual(out, "🚀🚀🚀🚀");
    });
  });
});
