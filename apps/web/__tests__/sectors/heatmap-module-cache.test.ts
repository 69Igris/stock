/**
 * MONEY-1126 — the sector heatmap's per-timeframe cache must survive an
 * UNMOUNT.
 *
 * Why this file exists: `/discover/markets` defaults to the STOCKS canvas and
 * `SectorsHeatmap` is mounted behind that canvas ternary, so
 * Sectors → Stocks → Sectors is the ordinary interaction and every return
 * REMOUNTS the component. The cache used to live in `useRef`s, which die with
 * the mount, so each return refetched from zero behind a full-box spinner.
 *
 * Hoisting a cache is easy to get subtly wrong, and three of the four ways
 * were already fixed once and are protected by comments in the source:
 *
 *   1. It must not be STATE. As state the cache sat in its own effect's
 *      dependency array while the effect rewrote it with a fresh object, so a
 *      successful-but-EMPTY response re-fired the effect forever.
 *   2. An empty result must be remembered as "fetched and empty", not retried
 *      indefinitely.
 *   3. Staleness is per TIMEFRAME, not per component — a stale 1D switched
 *      away from and back to must still carry its warning banner.
 *   4. The SSR seed (`initialBuckets` + `initialStaleSince`) must keep
 *      behaving exactly as before.
 *
 * Source-level assertions (no DOM runtime in this suite), matching the
 * convention in __tests__/markets/default-canvas.test.ts and
 * __tests__/screener/results-skeleton-theme.test.ts.
 *
 * Source: apps/web/app/discover/sectors/SectorsHeatmap.tsx
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(
  join(ROOT, "app/discover/sectors/SectorsHeatmap.tsx"),
  "utf8"
);

/** Source with comments removed. Needed wherever an assertion is about what
 *  the code DOES: this file's comments name the very identifiers some of the
 *  checks below forbid, so a raw-text search would fail on the explanation of
 *  the fix rather than on the fix. */
const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Everything above the component declaration, i.e. true module scope. */
function moduleScope(): string {
  const i = src.indexOf("export default function SectorsHeatmap");
  assert.ok(i > 0, "could not locate the SectorsHeatmap component declaration");
  return src.slice(0, i);
}

/** The body of the data-fetching effect (`useEffect(... , [tf, reloadNonce])`). */
function fetchEffect(): string {
  const start = src.indexOf("useEffect(() => {");
  assert.ok(start > 0, "could not locate the fetch effect");
  const end = src.indexOf("}, [tf, reloadNonce]);", start);
  assert.ok(
    end > start,
    "the fetch effect must still key on [tf, reloadNonce]"
  );
  return src.slice(start, end);
}

describe("MONEY-1126 — module-level sector cache", () => {
  describe("the store outlives the component", () => {
    it("declares the cache at MODULE scope, not inside the component", () => {
      assert.match(
        moduleScope(),
        /const sectorCache = new Map</,
        "the cache must be declared above the component so an unmount cannot " +
          "take it with it — that unmount is the whole bug"
      );
    });

    it("is a plain Map, never React state", () => {
      // Regression guard for the original defect: as state, the cache sat in
      // the effect's dep array and an empty response refetched forever.
      assert.doesNotMatch(
        src,
        /useState[^\n]*sectorCache/,
        "the cache must never be state — that is the infinite-refetch bug"
      );
      assert.doesNotMatch(
        src,
        /\}, \[tf, reloadNonce, sectorCache\]/,
        "the cache must never enter the effect's dependency array"
      );
    });

    it("no longer keeps the per-mount refs the cache replaced", () => {
      for (const dead of ["byTfRef", "staleByTfRef", "fetchedTfRef"]) {
        assert.doesNotMatch(
          code,
          new RegExp(dead),
          `${dead} died on unmount — it must be gone, not shadowed`
        );
      }
    });
  });

  describe("keyed by timeframe", () => {
    it("builds the key from the timeframe", () => {
      const match = src.match(
        /function sectorCacheKey\(tf: Timeframe\): string \{([\s\S]*?)\n\}/
      );
      assert.ok(match, "sectorCacheKey(tf) must exist");
      assert.match(
        match[1],
        /\$\{tf\}/,
        "the timeframe must be part of the key or 1W data would be served for 1D"
      );
    });

    it("also pins the other action inputs into the key", () => {
      // `getSectorHeatmapAction` is called with only a timeframe today: it
      // hard-codes scope "all" internally and topConstituents defaults to 6.
      // Both are in the key so that if either ever becomes a prop, the key
      // moves with it instead of silently serving one variant for another.
      const match = src.match(
        /function sectorCacheKey\(tf: Timeframe\): string \{([\s\S]*?)\n\}/
      );
      assert.ok(match);
      assert.match(match[1], /SECTOR_SCOPE/);
      assert.match(match[1], /SECTOR_TOP_N/);
      assert.match(moduleScope(), /const SECTOR_SCOPE = "all"/);
      assert.match(moduleScope(), /const SECTOR_TOP_N = 6/);
    });

    it("every read/write goes through the keying helper", () => {
      // Direct `sectorCache.get("1D")` style access would bypass the key
      // construction above and desync the two halves.
      const rawAccess = src.match(/sectorCache\.(get|set|delete)\(/g) ?? [];
      assert.equal(
        rawAccess.length,
        3,
        "expected exactly one raw get/set/delete, each inside its helper"
      );
      for (const helper of [
        /function readSectorCache\([\s\S]*?sectorCache\.get\(sectorCacheKey\(tf\)\)/,
        /function writeSectorCache\([\s\S]*?sectorCache\.set\(sectorCacheKey\(tf\)/,
        /function invalidateSectorCache\([\s\S]*?sectorCache\.delete\(sectorCacheKey\(tf\)\)/,
      ]) {
        assert.match(src, helper);
      }
    });
  });

  describe("TTL — a cache that never refreshes is a stale-data bug", () => {
    it("stamps every entry with the time it was stored", () => {
      assert.match(
        src,
        /function writeSectorCache\([\s\S]*?storedAt: Date\.now\(\)/,
        "entries must carry a timestamp or expiry cannot be computed"
      );
    });

    it("expires entries older than the TTL", () => {
      assert.match(
        moduleScope(),
        /const SECTOR_CACHE_TTL_MS = 60_000;/,
        "60s matches discover-heatmap.ts's own `ttlSeconds: isLive ? 60 : 300` " +
          "— the shortest interval in which the server could produce a new number"
      );
      assert.match(
        src,
        /Date\.now\(\) - entry\.storedAt < SECTOR_CACHE_TTL_MS/,
        "freshness must be an age comparison against the TTL"
      );
    });

    it("treats an expired entry as a MISS for fetching purposes", () => {
      const effect = fetchEffect();
      assert.match(
        effect,
        /if \(cached && isFreshEntry\(cached\)\) \{/,
        "only a FRESH entry may short-circuit the fetch"
      );
      // ...while still painting the expired copy underneath the refetch,
      // rather than blanking the grid (stale-while-revalidate).
      assert.match(
        effect,
        /if \(cached\) \{\s*setBuckets\(cached\.buckets\);/,
        "an expired entry should still paint while the refetch runs"
      );
      assert.match(
        effect,
        /getSectorHeatmapAction\(\{ timeframe: tf \}\)/,
        "an expired entry must fall through to a real refetch"
      );
    });
  });

  describe("a remount within the TTL renders instantly", () => {
    it("seeds `buckets` from the store, not just from the SSR prop", () => {
      assert.match(
        src,
        /useState<SectorHeatmapBucket\[\]>\(\s*seed\.entry\?\.buckets \?\? initialBuckets \?\? \[\]\s*\)/,
        "the store must win over the SSR prop — on a remount the prop is the " +
          "page-LOAD payload and the store holds whatever loaded since"
      );
    });

    it("seeds `loading` false when the store has a fresh entry", () => {
      // This is the spinner the user complained about: without it, a remount
      // opens on the skeleton even though the data is already in hand.
      assert.match(
        src,
        /const \[loading, setLoading\] = useState\(\s*!seed\.fresh &&/,
        "a fresh entry means nothing is in flight — do not open on a skeleton"
      );
    });

    it("restores the whole view, not just the buckets, on a cache hit", () => {
      // Each of these was a separate shipped bug (see the source comment).
      const effect = fetchEffect();
      const hit = effect.slice(
        effect.indexOf("if (cached && isFreshEntry(cached)) {"),
        effect.indexOf("let cancelled = false;")
      );
      assert.match(hit, /setBuckets\(cached\.buckets\)/);
      assert.match(hit, /setStaleSince\(cached\.staleSince\)/);
      assert.match(hit, /setError\(null\)/);
      assert.match(hit, /setLoading\(false\)/);
      assert.match(hit, /\n\s*return;/, "the cache hit must short-circuit");
    });

    it("the store survives the component but the effect key does not change", () => {
      // The effect must still be driven by [tf, reloadNonce] only. Adding the
      // module cache to the deps would reintroduce the refetch loop.
      assert.match(src, /\}, \[tf, reloadNonce\]\);/);
    });
  });

  describe("[regression] an empty result stays remembered as fetched", () => {
    it("writes the entry on EVERY success, including an empty bucket list", () => {
      const effect = fetchEffect();
      const success = effect.slice(
        effect.indexOf("setBuckets(res.data.buckets)")
      );
      assert.match(
        success,
        /writeSectorCache\(tf, res\.data\.buckets, staleAt\)/,
        "an empty-but-successful response must be cached too"
      );
      assert.doesNotMatch(
        success,
        /if \(res\.data\.buckets\.length[^)]*\)\s*\{?\s*writeSectorCache/,
        "gating the write on a non-empty list is exactly the retry-forever bug"
      );
    });

    it("does not cache a FAILED fetch", () => {
      // A failure must stay retryable; only the success path writes.
      const writes = src.match(/writeSectorCache\(/g) ?? [];
      assert.equal(
        writes.length,
        3,
        "expected the declaration, the SSR seed and exactly one success-path write"
      );
      assert.doesNotMatch(
        src,
        /\.catch\(\(err: unknown\) => \{[\s\S]*?writeSectorCache/,
        "the error path must never write a cache entry"
      );
    });

    it("'Try again' / 'Retry' evict the entry so the refetch is real", () => {
      const invalidations = src.match(/invalidateSectorCache\(tf\);/g) ?? [];
      assert.equal(
        invalidations.length,
        3,
        "all three retry affordances (empty-state, server-stale banner, " +
          "client-stale banner) must evict before bumping the nonce"
      );
      assert.match(
        src,
        /invalidateSectorCache\(tf\);\s*setReloadNonce\(\(n\) => n \+ 1\);/,
        "evict THEN bump — bumping alone would hit the fresh entry and no-op"
      );
    });
  });

  describe("[regression] stale-SSR semantics are unchanged", () => {
    it("still accepts and honours `initialStaleSince`", () => {
      assert.match(src, /initialStaleSince\?: number \| null;/);
      assert.match(
        src,
        /writeSectorCache\("1D", initialBuckets, initialStaleSince \?\? null\)/,
        "the SSR stale marker must ride along with the SSR buckets, or an " +
          "hours-old server render renders as live for the whole session"
      );
    });

    it("keeps staleness per ENTRY, i.e. still per timeframe", () => {
      assert.match(
        src,
        /interface SectorCacheEntry \{[\s\S]*?staleSince: number \| null;[\s\S]*?\}/,
        "staleness must live on the entry — held globally it desynced when " +
          "switching away from a stale timeframe and back"
      );
      assert.match(
        src,
        /const \[staleSince, setStaleSince\] = useState<number \| null>\(\s*seed\.entry \? seed\.entry\.staleSince : null\s*\)/
      );
    });

    it("only seeds from SSR when there is something to seed", () => {
      assert.match(
        src,
        /if \(initialBuckets\?\.length && ssrSeedIdentity !== initialBuckets\)/,
        "an empty SSR payload (the 6s withTimeout fired) must not overwrite a " +
          "real cached entry with nothing"
      );
    });

    it("guards the SSR seed on the ARRAY IDENTITY, not a boolean", () => {
      // A boolean "seeded once" flag would never take a fresh server render
      // after a soft navigation; re-seeding every mount would re-stamp
      // page-load data as brand new and the TTL would never fire.
      assert.match(
        moduleScope(),
        /let ssrSeedIdentity: SectorHeatmapBucket\[\] \| null = null;/
      );
      assert.match(src, /ssrSeedIdentity = initialBuckets;/);
    });

    it("folds the SSR props in before any state reads the store", () => {
      // Hook initialisers run top-to-bottom, so the seeding useState must be
      // the FIRST one in the component or `buckets`/`loading` would seed from
      // an empty store on a cold page load.
      const body = src.slice(
        src.indexOf("export default function SectorsHeatmap")
      );
      const firstUseState = body.indexOf("useState(");
      const seedCall = body.indexOf("seedSectorCacheFromSsr(");
      assert.ok(
        seedCall > firstUseState,
        "the seed must run inside the first useState"
      );
      assert.ok(
        seedCall < body.indexOf("const [buckets, setBuckets]"),
        "the store must be seeded before `buckets` reads it"
      );
    });
  });

  describe("the cache holds global market data only", () => {
    it("caches buckets, a timestamp and a stale marker — nothing user-scoped", () => {
      const entry = src.match(/interface SectorCacheEntry \{([\s\S]*?)\n\}/);
      assert.ok(entry);
      const fields = (entry[1].match(/^\s*(\w+):/gm) ?? []).map((f) =>
        f.trim().replace(":", "")
      );
      assert.deepEqual(fields.sort(), ["buckets", "staleSince", "storedAt"]);
      for (const forbidden of [
        /userId/,
        /clerkId/,
        /holdings/i,
        /portfolio/i,
      ]) {
        assert.doesNotMatch(
          entry[1],
          forbidden,
          "nothing user-derived may enter a module-level (cross-session) store"
        );
      }
    });

    it("the action it caches takes no user input", () => {
      // `getSectorHeatmapAction({ timeframe })` — no id, no session. The
      // server already caches the identical payload under scope "_global".
      const calls = src.match(/getSectorHeatmapAction\([^)]*\)/g) ?? [];
      assert.deepEqual(calls, ["getSectorHeatmapAction({ timeframe: tf })"]);
    });
  });
});
