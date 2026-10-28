/**
 * UNIT TEST — `refreshNews` reports what it PERSISTED (MONEY-1238, finding #9).
 *
 * `getOrFetchNews` structurally cannot fail. `news-client.fetchNews` catches its
 * own errors and returns `[]` on a non-2xx — a Google News 403 against our
 * egress included — the per-article upsert swallows constraint errors, and the
 * outer catch returns whatever was already in the table. Every one of those
 * paths hands the caller an ordinary array of stored articles, so `news-sync`
 * counted the CALL and reported `written: 50` over a `stock_news` table whose
 * newest row was four months old.
 *
 * These cases drive the REAL exported `refreshNews` against an in-memory store
 * and an injected fetcher. No socket, no Prisma handle, no timer.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { refreshNews, getOrFetchNews } from "../src/data-sources/db-store";

/* -------------------------------------------------------------------------- */
/* In-memory `stock_news`                                                      */
/* -------------------------------------------------------------------------- */

interface Row {
  symbol: string;
  link: string;
  title: string;
  pubDate: Date | null;
  source: string;
  snippet: string | null;
  fetchedAt: Date;
}

/**
 * A Prisma stand-in covering exactly the four calls `refreshNews` makes.
 * `upsertThrowsFor` reproduces the constraint error the real code swallows.
 */
function makeDb(
  rows: Row[],
  opts: { instrument?: { id: string } | null; upsertThrowsFor?: string } = {},
) {
  const upserts: Array<{ link: string; branch: "create" | "update" }> = [];
  const db = {
    upserts,
    stockNews: {
      findMany: async (args: {
        where: { symbol: string; link?: { in: string[] } };
        select?: { link: true };
      }) => {
        const matched = rows.filter(
          (r) =>
            r.symbol === args.where.symbol &&
            (!args.where.link || args.where.link.in.includes(r.link)),
        );
        return args.select
          ? matched.map((r) => ({ link: r.link }))
          : [...matched].sort(
              (a, b) => b.fetchedAt.getTime() - a.fetchedAt.getTime(),
            );
      },
      upsert: async (args: {
        where: { symbol_link: { symbol: string; link: string } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { symbol, link } = args.where.symbol_link;
        if (opts.upsertThrowsFor === link) {
          throw new Error("E11000 duplicate key");
        }
        const existing = rows.find(
          (r) => r.symbol === symbol && r.link === link,
        );
        if (existing) {
          existing.fetchedAt = new Date();
          upserts.push({ link, branch: "update" });
          return existing;
        }
        const created: Row = {
          symbol,
          link,
          title: String(args.create.title ?? ""),
          pubDate: null,
          source: "GOOGLE_NEWS",
          snippet: null,
          fetchedAt: new Date(),
        };
        rows.push(created);
        upserts.push({ link, branch: "create" });
        return created;
      },
    },
    instrumentMapping: {
      findFirst: async () =>
        opts.instrument === undefined ? { id: "inst1" } : opts.instrument,
    },
  };
  return db;
}

const article = (n: number) => ({
  title: `Headline ${n}`,
  link: `https://news.example/${n}`,
  pubDate: "2026-08-20T09:00:00.000Z",
  snippet: `snippet ${n}`,
});

const storedRow = (link: string, ageMs: number): Row => ({
  symbol: "AAA",
  link,
  title: "old",
  pubDate: null,
  source: "GOOGLE_NEWS",
  snippet: null,
  fetchedAt: new Date(Date.now() - ageMs),
});

const HOUR = 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */

describe("refreshNews reports rows, not calls", () => {
  it("REGRESSION: a 403 upstream yields ZERO writes and does not throw", async () => {
    // `fetchNews` returns [] on any non-2xx. Before MONEY-1238 the only thing
    // the caller could observe was the returned array — which is the STORED
    // rows, so it looked like a healthy fetch.
    const rows = [storedRow("https://news.example/old", 2 * HOUR)];
    const db = makeDb(rows);

    const r = await refreshNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => [],
    });

    assert.equal(r.created, 0);
    assert.equal(r.updated, 0);
    assert.equal(r.fetched, 0);
    assert.equal(r.failed, 0);
    assert.equal(r.fetchFailed, false, "a 403 does NOT surface as an error");
    assert.equal(r.servedFresh, false);
    assert.deepEqual(db.upserts, [], "nothing was upserted");
    assert.equal(
      r.articles.length,
      1,
      "the stale stored row is still returned",
    );
  });

  it("splits created from updated over one extra query, not one per article", async () => {
    const rows = [storedRow("https://news.example/1", 2 * HOUR)];
    const db = makeDb(rows);

    const r = await refreshNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => [article(1), article(2), article(3)],
    });

    assert.equal(r.fetched, 3);
    assert.equal(r.created, 2, "articles 2 and 3 are new");
    assert.equal(r.updated, 1, "article 1 was already held");
    assert.equal(r.failed, 0);
    assert.equal(db.upserts.length, 3);
  });

  it("a failed upsert is counted as failed, never as written", async () => {
    const db = makeDb([storedRow("https://news.example/x", 2 * HOUR)], {
      upsertThrowsFor: "https://news.example/2",
    });

    const r = await refreshNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => [article(1), article(2)],
    });

    assert.equal(r.created, 1);
    assert.equal(r.updated, 0);
    assert.equal(r.failed, 1);
  });

  it("an internal error is reported as fetchFailed, with the stored rows", async () => {
    const rows = [storedRow("https://news.example/old", 2 * HOUR)];
    const db = makeDb(rows);

    const r = await refreshNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => {
        throw new Error("socket hang up");
      },
    });

    assert.equal(r.fetchFailed, true);
    assert.equal(r.created, 0);
    assert.equal(r.updated, 0);
    assert.equal(r.articles.length, 1);
  });

  it("a copy inside the 30-minute window is served without a fetch", async () => {
    const db = makeDb([storedRow("https://news.example/fresh", 60_000)]);
    let fetched = false;

    const r = await refreshNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => {
        fetched = true;
        return [article(9)];
      },
    });

    assert.equal(fetched, false, "the freshness gate must short-circuit");
    assert.equal(r.servedFresh, true);
    assert.equal(r.created + r.updated, 0);
    assert.equal(r.fetchFailed, false);
  });

  it("writes with no instrument row still land (the un-connected create)", async () => {
    const db = makeDb([], { instrument: null });
    const r = await refreshNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => [article(1)],
    });
    assert.equal(r.created, 1);
  });

  it("getOrFetchNews still returns just the articles", async () => {
    // Back-compat: the wrapper delegates to `refreshNews` and drops the
    // counters, which is exactly why the worker had to move off it — this
    // return value cannot tell you whether anything was written.
    const db = makeDb([]);
    const out = await getOrFetchNews("AAA", 10, {
      prisma: db as never,
      fetchNews: async () => [article(1), article(2)],
    });

    assert.ok(Array.isArray(out));
    assert.equal(out.length, 2);
    assert.equal(db.upserts.length, 2, "the wrapper still persists");
    assert.equal(
      (out as unknown as Record<string, unknown>).created,
      undefined,
      "an array cannot carry a write count — that was the whole problem",
    );
  });
});
