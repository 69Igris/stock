/**
 * Tests for nse-json-archive.ts (MONEY-1098 P5.7).
 *
 * The key derivation is the falsifiable part — which paths archive, which are
 * deliberately skipped, and that windowed backfills produce distinct keys.
 * The I/O wrapper is exercised against a fake store through the real mode
 * resolution (env-driven), including the never-throw contract.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nseJsonArchiveKey,
  archiveNseJsonResponse,
} from "../src/data-sources/nse-json-archive";
import {
  setFeedArchiveStore,
  type FeedArchiveStore,
} from "@usemoney/core/market-data";

const AT = new Date("2026-08-11T16:40:00.000Z");

describe("nseJsonArchiveKey", () => {
  it("keys the corporate-actions bulk window under its family, dated by fetch day", () => {
    const key = nseJsonArchiveKey(
      "/api/corporates-corporateActions?index=equities&from_date=01-01-2005&to_date=30-06-2005",
      AT,
    );
    assert.equal(
      key,
      "feeds/NSE/api/corporate-actions/2026/08/2026-08-11-corporates-corporateActions-index-equities-from-date-01-01-2005-to-date-30-06-2005.json",
    );
  });

  it("keeps windowed backfill keys DISTINCT — the window dates survive into the slug", () => {
    const a = nseJsonArchiveKey(
      "/api/corporates-corporateActions?index=equities&from_date=01-01-2005&to_date=30-06-2005",
      AT,
    );
    const b = nseJsonArchiveKey(
      "/api/corporates-corporateActions?index=equities&from_date=01-07-2005&to_date=31-12-2005",
      AT,
    );
    assert.ok(a && b && a !== b);
  });

  it("maps every P5 market-wide endpoint to a family", () => {
    const cases: Array<[string, string]> = [
      [
        "/api/corporate-announcements?index=equities&from_date=x",
        "announcements",
      ],
      ["/api/corporate-board-meetings?index=equities&w=1", "board-meetings"],
      ["/api/event-calendar?index=equities&w=1", "event-calendar"],
      ["/api/all-upcoming-issues?category=ipo", "issues"],
      ["/api/ipo-current-issue", "issues"],
      ["/api/public-past-issues", "issues"],
      [
        "/api/integrated-filing-results?index=equities&from_date=a&to_date=b",
        "integrated-filings",
      ],
      ["/api/corporate-pledgedata", "pledge"],
    ];
    for (const [path, family] of cases) {
      const key = nseJsonArchiveKey(path, AT);
      assert.ok(
        key?.startsWith(`feeds/NSE/api/${family}/2026/08/2026-08-11-`),
        `${path} → ${key}`,
      );
      assert.ok(key.endsWith(".json"));
    }
  });

  it("skips per-symbol paths — the deliberate volume/value exclusion", () => {
    assert.equal(
      nseJsonArchiveKey(
        "/api/corporates-corporateActions?index=equities&symbol=RELIANCE",
        AT,
      ),
      null,
    );
    assert.equal(
      nseJsonArchiveKey("/api/annual-reports?index=equities&symbol=INFY", AT),
      null,
    );
    assert.equal(
      nseJsonArchiveKey("/api/corporate-share-holdings-master?symbol=TCS", AT),
      null,
    );
  });

  it("skips unknown endpoints and non-/api/ paths — archiving is by table, not by guess", () => {
    assert.equal(nseJsonArchiveKey("/api/daily-reports?key=CM", AT), null);
    assert.equal(nseJsonArchiveKey("/market-data/live", AT), null);
    assert.equal(nseJsonArchiveKey("", AT), null);
  });
});

describe("archiveNseJsonResponse", () => {
  const puts: Array<{ key: string; body: string; contentType: string }> = [];
  const fakeStore: FeedArchiveStore = {
    get: async () => null,
    put: async (key, body, contentType) => {
      puts.push({ key, body: body.toString("utf8"), contentType });
    },
  };
  const prevMode = process.env.FEED_ARCHIVE_MODE;

  beforeEach(() => {
    puts.length = 0;
    setFeedArchiveStore(fakeStore);
  });
  afterEach(() => {
    setFeedArchiveStore(null);
    if (prevMode === undefined) delete process.env.FEED_ARCHIVE_MODE;
    else process.env.FEED_ARCHIVE_MODE = prevMode;
  });

  it("writes the raw text with application/json when armed", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    await archiveNseJsonResponse("/api/ipo-current-issue", '{"data":[1]}');
    assert.equal(puts.length, 1);
    assert.match(
      puts[0]!.key,
      /^feeds\/NSE\/api\/issues\/\d{4}\/\d{2}\/\d{4}-\d{2}-\d{2}-ipo-current-issue\.json$/,
    );
    assert.equal(puts[0]!.body, '{"data":[1]}');
    assert.equal(puts[0]!.contentType, "application/json");
  });

  it("is a no-op when the archive is not armed (replay / unset)", async () => {
    delete process.env.FEED_ARCHIVE_MODE;
    await archiveNseJsonResponse("/api/ipo-current-issue", "{}");
    process.env.FEED_ARCHIVE_MODE = "replay";
    await archiveNseJsonResponse("/api/ipo-current-issue", "{}");
    assert.equal(puts.length, 0);
  });

  it("is a no-op for paths the key derivation rejects", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    await archiveNseJsonResponse("/api/corporates-pit?symbol=TCS", "{}");
    assert.equal(puts.length, 0);
  });

  it("never throws — a store failure is swallowed, the fetch result stands", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    setFeedArchiveStore({
      get: async () => null,
      put: async () => {
        throw new Error("GCS on fire");
      },
    });
    await assert.doesNotReject(
      archiveNseJsonResponse("/api/ipo-current-issue", "{}"),
    );
  });

  it("is a no-op when no store is registered (Vercel / local)", async () => {
    process.env.FEED_ARCHIVE_MODE = "archive";
    setFeedArchiveStore(null);
    await archiveNseJsonResponse("/api/ipo-current-issue", "{}");
    assert.equal(puts.length, 0);
  });
});
