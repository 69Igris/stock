/**
 * MONEY-785 (P4) — fetch_youtube_transcript research tool — REAL imports.
 *
 * Covers `packages/research/src/tools/fetch-youtube-transcript.ts`:
 *   - the tool's execute() degrade paths (empty url → error; unrecognisable url
 *     → available:false; no captions → available:false; happy path returns the
 *     capped transcript + citable source; a symbol triggers a best-effort
 *     persist that NEVER affects the response).
 *   - persistYoutubeTranscript path-building, symbol/videoId sanitisation,
 *     never-throw, and the no-instrument → null guard — all via an INJECTED fake
 *     prisma client (no real DB, no network). global `fetch` is stubbed for the
 *     transcript fetcher.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  fetchYoutubeTranscriptTool,
  persistYoutubeTranscript,
  MAX_TRANSCRIPT_CHARS,
  type TranscriptPrismaClient,
} from "../src/tools/fetch-youtube-transcript";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ID = "dQw4w9WgXcQ";
const JSON3_HELLO = JSON.stringify({
  events: [{ segs: [{ utf8: "Earnings " }, { utf8: "call text" }] }],
});

/** Stub fetch so discovery is empty and the FIRST direct fallback yields text. */
function installTranscriptFetch(body: string | null): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/watch")) {
      return {
        ok: true,
        status: 200,
        text: async () => "<html></html>",
      } as unknown as Response;
    }
    if (body === null) {
      return {
        ok: false,
        status: 404,
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  }) as typeof fetch;
}

// ── fake injectable prisma client ──────────────────────────────────────────

interface FakeDbOptions {
  instrument?: { id: string } | null;
  onUpsert?: (args: {
    where: unknown;
    create: Record<string, unknown>;
  }) => void;
  throwOnUpsert?: boolean;
}

function fakeDb(opts: FakeDbOptions = {}): TranscriptPrismaClient {
  const instrument =
    opts.instrument === undefined ? { id: "inst-1" } : opts.instrument;
  return {
    instrumentMapping: {
      findFirst: async () => instrument,
    },
    stockDocument: {
      upsert: async (args: {
        where: unknown;
        create: Record<string, unknown>;
      }) => {
        if (opts.throwOnUpsert) throw new Error("db down");
        opts.onUpsert?.(args);
        return { id: "doc-1" };
      },
    },
  };
}

// ── tool.execute — degrade + happy paths ────────────────────────────────────

describe("fetchYoutubeTranscriptTool.execute — degrade paths", () => {
  it("errors when url is missing/blank", async () => {
    const r = await fetchYoutubeTranscriptTool.execute({ url: "   " });
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /url is required/i);
  });

  it("available:false for an unrecognisable url (no fetch attempted)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return {
        ok: true,
        status: 200,
        text: async () => "",
      } as unknown as Response;
    }) as typeof fetch;

    const r = await fetchYoutubeTranscriptTool.execute({
      url: "not a youtube link",
    });
    assert.equal(r.success, true);
    const data = r.data as {
      available: boolean;
      videoId: null;
      reason?: string;
    };
    assert.equal(data.available, false);
    assert.equal(data.videoId, null);
    assert.equal(called, false, "must not fetch for an unparseable url");
  });

  it("available:false when the video has no captions", async () => {
    installTranscriptFetch(null);
    const r = await fetchYoutubeTranscriptTool.execute({
      url: `https://youtu.be/${ID}`,
    });
    assert.equal(r.success, true);
    const data = r.data as { available: boolean; videoId: string };
    assert.equal(data.available, false);
    assert.equal(data.videoId, ID);
  });

  it("happy path: returns the transcript + a canonical citable source", async () => {
    installTranscriptFetch(JSON3_HELLO);
    const r = await fetchYoutubeTranscriptTool.execute({
      url: `https://www.youtube.com/watch?v=${ID}`,
    });
    assert.equal(r.success, true);
    const data = r.data as {
      available: boolean;
      videoId: string;
      transcript?: string;
      source: string;
    };
    assert.equal(data.available, true);
    assert.equal(data.videoId, ID);
    assert.equal(data.transcript, "Earnings call text");
    assert.equal(data.source, `https://www.youtube.com/watch?v=${ID}`);
  });

  it("caps the transcript at MAX_TRANSCRIPT_CHARS", async () => {
    const big = JSON.stringify({
      events: [{ segs: [{ utf8: "x".repeat(MAX_TRANSCRIPT_CHARS + 5_000) }] }],
    });
    installTranscriptFetch(big);
    const r = await fetchYoutubeTranscriptTool.execute({ url: ID });
    const data = r.data as { transcript?: string };
    assert.equal(data.transcript?.length, MAX_TRANSCRIPT_CHARS);
  });

  it("a symbol does NOT change the response (persist is best-effort/fire-and-forget)", async () => {
    installTranscriptFetch(JSON3_HELLO);
    // No DB configured here → persist no-ops internally; response is unaffected.
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const r = await fetchYoutubeTranscriptTool.execute({
        url: ID,
        symbol: "RELIANCE",
      });
      assert.equal(r.success, true);
      assert.equal((r.data as { available: boolean }).available, true);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });
});

// ── persistYoutubeTranscript (injected DB) ──────────────────────────────────

describe("persistYoutubeTranscript — injected prisma, never-throw", () => {
  it("returns null on a blank transcript (nothing to store)", async () => {
    const id = await persistYoutubeTranscript(
      "RELIANCE",
      ID,
      "u",
      "   ",
      undefined,
      fakeDb(),
    );
    assert.equal(id, null);
  });

  it("returns null when the videoId is not a valid 11-char id", async () => {
    const id = await persistYoutubeTranscript(
      "RELIANCE",
      "bad",
      "u",
      "text",
      undefined,
      fakeDb(),
    );
    assert.equal(id, null);
  });

  it("returns null when no active instrument resolves", async () => {
    const id = await persistYoutubeTranscript(
      "NOPE",
      ID,
      "u",
      "some transcript",
      undefined,
      fakeDb({ instrument: null }),
    );
    assert.equal(id, null);
  });

  it("upserts with a path-safe gcsPath + per-video period and returns the id", async () => {
    let captured: { where: unknown; create: Record<string, unknown> } | null =
      null;
    const id = await persistYoutubeTranscript(
      "reliance.ns",
      ID,
      "https://www.youtube.com/watch?v=" + ID,
      "the earnings transcript",
      undefined,
      fakeDb({ onUpsert: (a) => (captured = a) }),
    );
    assert.equal(id, "doc-1");
    assert.ok(captured);
    const create = captured!.create;
    // Symbol canonicalised (suffix stripped, upper-cased).
    assert.equal(create.symbol, "RELIANCE");
    assert.equal(create.docType, "video_transcript");
    assert.equal(create.period, `video-${ID}`);
    assert.equal(create.processingStatus, "READY");
    assert.equal(create.textContent, "the earnings transcript");
    // gcsPath stays under the stocks/ prefix and carries the sanitised symbol.
    assert.equal(
      create.gcsPath,
      `stocks/RELIANCE/video_transcript/RELIANCE-video_transcript-video-${ID}.txt`,
    );
  });

  it("SECURITY: a path-traversal symbol cannot escape the stocks/ prefix", async () => {
    let captured: { create: Record<string, unknown> } | null = null;
    const id = await persistYoutubeTranscript(
      "../../etc/passwd",
      ID,
      "u",
      "text",
      undefined,
      fakeDb({
        onUpsert: (a) => (captured = a as { create: Record<string, unknown> }),
      }),
    );
    // Symbol sanitises to "ETCPASSWD" (dots/slashes stripped) → still resolves +
    // persists, but the path NEVER contains `..` or a stray `/` segment.
    assert.equal(id, "doc-1");
    const gcsPath = String(captured!.create.gcsPath);
    assert.ok(gcsPath.startsWith("stocks/"));
    assert.ok(!gcsPath.includes(".."), `path must not contain ..: ${gcsPath}`);
    // exactly the 4 expected segments: stocks / SYMBOL / docType / filename
    assert.equal(gcsPath.split("/").length, 4);
  });

  it("never throws when the upsert fails (best-effort → null)", async () => {
    const id = await persistYoutubeTranscript(
      "RELIANCE",
      ID,
      "u",
      "text",
      undefined,
      fakeDb({ throwOnUpsert: true }),
    );
    assert.equal(id, null);
  });
});
