/**
 * MONEY-1124 — symbol-keyed quote cache resolver (REAL source).
 *
 * Drives the ACTUAL exported `resolveQuotesCached` (+ its pure helpers) from
 * `@/lib/market/quote-cache-logic` — the module `lib/market/quote-cache.ts`
 * and therefore `/api/market/quote` run in production. No inline copies.
 *
 * All I/O arrives through the injected `QuoteCachePorts`, so nothing here
 * touches Redis, Prisma or the network. The only timer in play is the
 * resolver's own budget timer, which it clears; the "hanging fetch" case uses a
 * promise that NEVER settles (rather than a slow one) so the suite cannot
 * orphan on a pending handle.
 *
 * Source: apps/web/lib/market/quote-cache-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_CACHE_TTL_MS,
  dedupeSymbols,
  isEnvelopeFresh,
  partitionBySymbolCache,
  quoteCacheIdentifier,
  resolveQuotesCached,
  toEpochMs,
  withBudget,
  type CachedQuoteEnvelope,
  type QuoteCachePorts,
} from "@/lib/market/quote-cache-logic";

// ── fixtures ────────────────────────────────────────────────────────

interface FakeQuote {
  symbol: string;
  price: number;
  timestamp: Date;
}

const NOW = 1_770_000_000_000; // fixed epoch ms

function quote(symbol: string, price = 100, quotedAt = NOW): FakeQuote {
  return { symbol, price, timestamp: new Date(quotedAt) };
}

function envelope(
  symbol: string,
  cachedAt: number,
  quotedAt = NOW
): CachedQuoteEnvelope<FakeQuote> {
  return {
    quote: quote(symbol, 100, quotedAt),
    key: symbol,
    cachedAt,
    source: "yahoo",
  };
}

interface Recorder {
  readCache: string[][];
  writeCache: string[][];
  readDb: string[][];
  readUpstream: string[][];
}

interface PortOverrides {
  cache?: Map<string, CachedQuoteEnvelope<FakeQuote>>;
  db?: Map<string, FakeQuote>;
  upstream?: Map<string, FakeQuote>;
  /** Replace the upstream leg entirely (e.g. a promise that never settles). */
  upstreamImpl?: (
    symbols: string[]
  ) => Promise<{ quotes: Map<string, FakeQuote>; source: string }>;
  dbImpl?: (symbols: string[]) => Promise<Map<string, FakeQuote>>;
  /** Response key mapping; defaults to identity (RELIANCE → RELIANCE). */
  responseKey?: (symbol: string) => string;
  now?: () => number;
}

function makePorts(overrides: PortOverrides = {}): {
  ports: QuoteCachePorts<FakeQuote>;
  rec: Recorder;
} {
  const rec: Recorder = {
    readCache: [],
    writeCache: [],
    readDb: [],
    readUpstream: [],
  };
  const cache = overrides.cache ?? new Map();
  const db = overrides.db ?? new Map();
  const upstream = overrides.upstream ?? new Map();
  const responseKey = overrides.responseKey ?? ((s: string) => s);

  const ports: QuoteCachePorts<FakeQuote> = {
    readCache: async (symbols) => {
      rec.readCache.push([...symbols]);
      const found = new Map<string, CachedQuoteEnvelope<FakeQuote>>();
      for (const s of symbols) {
        const hit = cache.get(s);
        if (hit) found.set(s, hit);
      }
      return found;
    },
    writeCache: async (entries) => {
      rec.writeCache.push(entries.map((e) => e.symbol));
      for (const { symbol, envelope: env } of entries) cache.set(symbol, env);
    },
    readDb: async (symbols) => {
      rec.readDb.push([...symbols]);
      if (overrides.dbImpl) return overrides.dbImpl(symbols);
      const found = new Map<string, FakeQuote>();
      for (const s of symbols) {
        const hit = db.get(s);
        if (hit) found.set(s, hit);
      }
      return found;
    },
    readUpstream: async (symbols) => {
      rec.readUpstream.push([...symbols]);
      if (overrides.upstreamImpl) return overrides.upstreamImpl(symbols);
      const found = new Map<string, FakeQuote>();
      for (const s of symbols) {
        const hit = upstream.get(responseKey(s));
        if (hit) found.set(responseKey(s), hit);
      }
      return { quotes: found, source: "yahoo" };
    },
    responseKey,
    quotedAtMs: (q) => toEpochMs(q.timestamp),
    now: overrides.now ?? (() => NOW),
  };

  return { ports, rec };
}

// ════════════════════════════════════════════════════════════════════
describe("MONEY-1124 — quote cache resolver (real source)", () => {
  // ── 1. cache hit does no external fetch ───────────────────────────
  describe("cache hit", () => {
    it("serves every symbol from the cache and performs NO db/upstream call", async () => {
      const symbols = ["RELIANCE", "TCS", "INFY"];
      const cache = new Map(symbols.map((s) => [s, envelope(s, NOW - 1_000)]));

      const { ports, rec } = makePorts({ cache });
      const result = await resolveQuotesCached(symbols, ports);

      assert.deepEqual(result.cacheHits, symbols);
      assert.deepEqual(result.dbHits, []);
      assert.deepEqual(result.upstreamHits, []);
      assert.equal(
        rec.readDb.length,
        0,
        "DB must not be touched on a full hit"
      );
      assert.equal(
        rec.readUpstream.length,
        0,
        "Yahoo must not be touched on a full hit"
      );
      assert.equal(Object.keys(result.quotes).length, 3);
      assert.equal(result.fromCache, true);
      assert.equal(result.partial, false);
    });

    it("does not re-write entries it served from the cache", async () => {
      const cache = new Map([["RELIANCE", envelope("RELIANCE", NOW - 1_000)]]);
      const { ports, rec } = makePorts({ cache });

      await resolveQuotesCached(["RELIANCE"], ports);

      assert.equal(rec.writeCache.length, 0);
    });

    it("an entry exactly at the TTL boundary is a MISS (strict <, never serves stale)", async () => {
      const cache = new Map([
        ["RELIANCE", envelope("RELIANCE", NOW - QUOTE_CACHE_TTL_MS)],
      ]);
      const upstream = new Map([["RELIANCE", quote("RELIANCE", 2500)]]);
      const { ports, rec } = makePorts({ cache, upstream });

      const result = await resolveQuotesCached(["RELIANCE"], ports);

      assert.deepEqual(result.cacheHits, []);
      assert.deepEqual(result.upstreamHits, ["RELIANCE"]);
      assert.equal(rec.readUpstream.length, 1);
    });
  });

  // ── 2. partial staleness ──────────────────────────────────────────
  describe("partial staleness", () => {
    it("5 symbols, 3 fresh / 2 stale → fetches EXACTLY the 2 stale ones", async () => {
      const symbols = ["A", "B", "C", "D", "E"];
      const cache = new Map<string, CachedQuoteEnvelope<FakeQuote>>([
        ["A", envelope("A", NOW - 1_000)], // fresh
        ["B", envelope("B", NOW - 2_000)], // fresh
        ["C", envelope("C", NOW - 3_000)], // fresh
        ["D", envelope("D", NOW - 60_000)], // stale
        ["E", envelope("E", NOW - 90_000)], // stale
      ]);
      const upstream = new Map([
        ["D", quote("D", 10)],
        ["E", quote("E", 20)],
      ]);

      const { ports, rec } = makePorts({ cache, upstream });
      const result = await resolveQuotesCached(symbols, ports);

      assert.deepEqual(result.cacheHits, ["A", "B", "C"]);
      assert.deepEqual(
        rec.readDb,
        [],
        "the DB leg is opt-in and this caller did not opt in"
      );
      assert.deepEqual(
        rec.readUpstream,
        [["D", "E"]],
        "only the stale subset hits Yahoo"
      );
      assert.deepEqual(result.upstreamHits, ["D", "E"]);
      assert.equal(Object.keys(result.quotes).length, 5);
      // Only the newly-resolved pair is written back.
      assert.deepEqual(rec.writeCache, [["D", "E"]]);
    });

    it("a symbol missing from the cache entirely counts as stale", async () => {
      const cache = new Map([["A", envelope("A", NOW - 1_000)]]);
      const upstream = new Map([["Z", quote("Z")]]);
      const { ports, rec } = makePorts({ cache, upstream });

      const result = await resolveQuotesCached(["A", "Z"], ports);

      assert.deepEqual(result.cacheHits, ["A"]);
      assert.deepEqual(rec.readUpstream, [["Z"]]);
    });

    it("skips Yahoo entirely when the LatestQuote DB answers the stale subset (opt-in)", async () => {
      const cache = new Map([["A", envelope("A", NOW - 1_000)]]);
      const db = new Map([["D", quote("D", 42)]]);
      const { ports, rec } = makePorts({ cache, db });

      const result = await resolveQuotesCached(["A", "D"], ports, {
        enableDbLeg: true,
      });

      assert.deepEqual(result.dbHits, ["D"]);
      assert.equal(
        rec.readUpstream.length,
        0,
        "a warm DB must serve the request with no external call"
      );
      assert.equal(result.quotes["D"]!.price, 42);
    });

    it("falls through DB → Yahoo for the symbols the DB could not answer (opt-in)", async () => {
      const db = new Map([["A", quote("A", 1)]]);
      const upstream = new Map([["B", quote("B", 2)]]);
      const { ports, rec } = makePorts({ db, upstream });

      const result = await resolveQuotesCached(["A", "B"], ports, {
        enableDbLeg: true,
      });

      assert.deepEqual(result.dbHits, ["A"]);
      assert.deepEqual(rec.readUpstream, [["B"]]);
      assert.deepEqual(result.upstreamHits, ["B"]);
    });

    it("[regression] the DB leg is OFF by default — a DB-servable symbol still goes upstream", async () => {
      // `latest_quotes` has no pe / eps / week52High / week52Low column, so a
      // DB-served quote is a strictly SMALLER shape than an upstream one.
      // Serving it from the general quote route blanked four of the eight tiles
      // on every stock page, and they flickered back whenever the upstream leg
      // happened to answer. The DB leg must therefore stay opt-in: a caller has
      // to declare that it only needs the price fields.
      const db = new Map([["A", quote("A", 1)]]);
      const upstream = new Map([["A", quote("A", 2)]]);
      const { ports, rec } = makePorts({ db, upstream });

      const result = await resolveQuotesCached(["A"], ports);

      assert.deepEqual(result.dbHits, [], "the DB leg must not run by default");
      assert.deepEqual(rec.readUpstream, [["A"]]);
      assert.equal(
        result.quotes["A"]!.price,
        2,
        "the full-shape upstream quote wins"
      );
    });
  });

  // ── keying / fail-open / freshness ────────────────────────────────
  describe("response keying", () => {
    it("emits under the provider's response key, not the request symbol (index aliases)", async () => {
      // Mirrors toYahooSymbol("NIFTY") → "^NSEI" → extractSymbol → "^NSEI".
      const responseKey = (s: string) => (s === "NIFTY" ? "^NSEI" : s);
      const upstream = new Map([["^NSEI", quote("^NSEI", 24000)]]);
      const { ports } = makePorts({ upstream, responseKey });

      const result = await resolveQuotesCached(["NIFTY"], ports);

      assert.ok("^NSEI" in result.quotes, "must key on the provider's symbol");
      assert.equal("NIFTY" in result.quotes, false);
    });

    it("a cache hit reuses the STORED key so it is byte-identical to a live fetch", async () => {
      const responseKey = (s: string) => (s === "NIFTY" ? "^NSEI" : s);
      const cache = new Map<string, CachedQuoteEnvelope<FakeQuote>>([
        [
          "NIFTY",
          {
            quote: quote("^NSEI", 24000),
            key: "^NSEI",
            cachedAt: NOW - 1_000,
            source: "yahoo",
          },
        ],
      ]);
      const { ports } = makePorts({ cache, responseKey });

      const result = await resolveQuotesCached(["NIFTY"], ports);

      assert.ok("^NSEI" in result.quotes);
      assert.deepEqual(result.cacheHits, ["NIFTY"]);
    });
  });

  describe("fail-open", () => {
    it("an unresolvable symbol is absent from data rather than an error", async () => {
      const upstream = new Map([["A", quote("A")]]);
      const { ports } = makePorts({ upstream });

      const result = await resolveQuotesCached(["A", "GHOST"], ports);

      assert.ok("A" in result.quotes);
      assert.equal("GHOST" in result.quotes, false);
      assert.deepEqual(result.unresolved, ["GHOST"]);
    });

    it("returns an empty payload (not a throw) for an empty symbol list", async () => {
      const { ports, rec } = makePorts();
      const result = await resolveQuotesCached([], ports);

      assert.deepEqual(result.quotes, {});
      assert.equal(rec.readCache.length, 0);
      assert.equal(result.asOfMs, null);
    });

    it("de-duplicates repeated symbols before doing any work", async () => {
      const upstream = new Map([["A", quote("A")]]);
      const { ports, rec } = makePorts({ upstream });

      await resolveQuotesCached(["A", "A", "A"], ports);

      assert.deepEqual(rec.readCache, [["A"]]);
      assert.deepEqual(rec.readUpstream, [["A"]]);
    });
  });

  describe("honest freshness (asOf)", () => {
    it("reports the OLDEST market timestamp in the payload, not the newest", async () => {
      const cache = new Map([
        ["OLD", envelope("OLD", NOW - 1_000, NOW - 900_000)],
      ]);
      const upstream = new Map([["NEW", quote("NEW", 5, NOW)]]);
      const { ports } = makePorts({ cache, upstream });

      const result = await resolveQuotesCached(["OLD", "NEW"], ports);

      assert.equal(
        result.asOfMs,
        NOW - 900_000,
        "a partially-cached payload must advertise its STALEST price"
      );
    });

    it("survives an ISO-string timestamp (the shape a Redis round trip returns)", async () => {
      const isoQuote = {
        symbol: "A",
        price: 1,
        timestamp: new Date(NOW - 5_000).toISOString(),
      } as unknown as FakeQuote;
      const cache = new Map<string, CachedQuoteEnvelope<FakeQuote>>([
        [
          "A",
          { quote: isoQuote, key: "A", cachedAt: NOW - 1_000, source: "yahoo" },
        ],
      ]);
      const { ports } = makePorts({ cache });

      const result = await resolveQuotesCached(["A"], ports);

      assert.equal(result.asOfMs, NOW - 5_000);
    });
  });

  // ── 5. time budget ────────────────────────────────────────────────
  describe("time budget", () => {
    it("a hanging upstream fetch returns within budget with partial results", async () => {
      const cache = new Map([["FRESH", envelope("FRESH", NOW - 1_000)]]);
      // Never settles — the exact shape of a Yahoo call stuck in its
      // 3 × 15s + backoff retry ladder, without leaving a timer behind.
      const upstreamImpl = () =>
        new Promise<{ quotes: Map<string, FakeQuote>; source: string }>(
          () => {}
        );

      const { ports } = makePorts({ cache, upstreamImpl });

      const startedAt = Date.now();
      const result = await resolveQuotesCached(["FRESH", "HANGS"], ports, {
        budgetMs: 30,
      });
      const elapsed = Date.now() - startedAt;

      assert.ok(
        elapsed < 2_000,
        `must return on the budget, took ${elapsed}ms`
      );
      assert.deepEqual(
        result.cacheHits,
        ["FRESH"],
        "cached rows still returned"
      );
      assert.equal("HANGS" in result.quotes, false);
      assert.deepEqual(result.unresolved, ["HANGS"]);
      assert.equal(result.partial, true, "must flag the payload as partial");
    });

    it("an already-exhausted budget short-circuits the upstream leg entirely", async () => {
      const { ports, rec } = makePorts();
      const result = await resolveQuotesCached(["A"], ports, { budgetMs: 0 });

      assert.equal(rec.readUpstream.length, 0);
      assert.deepEqual(result.quotes, {});
      assert.equal(result.partial, true);
    });

    it("a hanging DB read still lets the upstream leg run inside the remaining budget", async () => {
      const upstream = new Map([["A", quote("A", 7)]]);
      const { ports } = makePorts({
        upstream,
        dbImpl: () => new Promise<Map<string, FakeQuote>>(() => {}),
      });

      const result = await resolveQuotesCached(["A"], ports, {
        budgetMs: 400,
        dbBudgetMs: 20,
      });

      assert.deepEqual(result.upstreamHits, ["A"]);
      assert.equal(result.quotes["A"]!.price, 7);
    });
  });

  // ── pure helpers ──────────────────────────────────────────────────
  describe("pure helpers", () => {
    it("quoteCacheIdentifier is per symbol AND per exchange", () => {
      assert.equal(quoteCacheIdentifier("NSE", "RELIANCE"), "q:NSE:RELIANCE");
      assert.notEqual(
        quoteCacheIdentifier("NSE", "RELIANCE"),
        quoteCacheIdentifier("BSE", "RELIANCE")
      );
    });

    it("dedupeSymbols preserves first-seen order and drops empties", () => {
      assert.deepEqual(dedupeSymbols(["B", "A", "B", "", "A"]), ["B", "A"]);
    });

    it("isEnvelopeFresh: strictly-less-than TTL, future clock skew counts as fresh", () => {
      assert.equal(
        isEnvelopeFresh({ cachedAt: NOW - 14_999 }, NOW, 15_000),
        true
      );
      assert.equal(
        isEnvelopeFresh({ cachedAt: NOW - 15_000 }, NOW, 15_000),
        false
      );
      assert.equal(
        isEnvelopeFresh({ cachedAt: NOW + 5_000 }, NOW, 15_000),
        true
      );
      assert.equal(isEnvelopeFresh({ cachedAt: NaN }, NOW, 15_000), false);
    });

    it("partitionBySymbolCache keeps the requested order in `missing`", () => {
      const cached = new Map([["B", envelope("B", NOW)]]);
      const { hits, missing } = partitionBySymbolCache(
        ["A", "B", "C"],
        cached,
        NOW,
        15_000
      );
      assert.deepEqual(missing, ["A", "C"]);
      assert.equal(hits.size, 1);
    });

    it("toEpochMs normalises Date / ISO string / number and rejects junk", () => {
      assert.equal(toEpochMs(new Date(NOW)), NOW);
      assert.equal(toEpochMs(new Date(NOW).toISOString()), NOW);
      assert.equal(toEpochMs(NOW), NOW);
      assert.equal(toEpochMs("not-a-date"), null);
      assert.equal(toEpochMs(new Date("nope")), null);
      assert.equal(toEpochMs(undefined), null);
      assert.equal(toEpochMs(Number.NaN), null);
    });

    it("withBudget resolves the fallback on timeout", async () => {
      const timedOut = await withBudget(
        new Promise<string>(() => {}),
        10,
        "fallback"
      );
      assert.deepEqual(timedOut, { value: "fallback", timedOut: true });
    });

    it("withBudget swallows a rejection into the fallback (never an unhandled rejection)", async () => {
      // The handler is attached in the same statement the promise is created in,
      // which is exactly the contract the resolver relies on: no leg of the
      // chain may surface a rejection to the process.
      const rejected = await withBudget(
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("late")), 5);
        }),
        500,
        "fallback"
      );
      assert.deepEqual(rejected, { value: "fallback", timedOut: false });
    });

    it("withBudget passes the resolved value straight through when fast", async () => {
      const out = await withBudget(Promise.resolve("ok"), 1_000, "fallback");
      assert.deepEqual(out, { value: "ok", timedOut: false });
    });
  });
});
