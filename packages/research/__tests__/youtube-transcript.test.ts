/**
 * MONEY-785 (P4) — YouTube caption scraper — REAL imports, stubbed `fetch`.
 *
 * Covers `packages/research/src/data-sources/youtube-transcript.ts`:
 *   - parseVideoId          → every URL shape + bare id + junk + the loose `v=`
 *                             fallback, AND the SECURITY rule that a real URL on
 *                             a NON-youtube host never yields an id.
 *   - fetchYoutubeTranscript→ discovery (manual-EN preferred), ASR/direct
 *                             fallback, JSON3 + legacy-XML parsing, entity decode,
 *                             empty/blocked → null, and the SSRF guard that a
 *                             poisoned baseUrl pointing at evil.com is NEVER
 *                             fetched, plus per-fetch timeout → null.
 *
 * The fetcher is dependency-free and uses global `fetch`; every test installs a
 * deterministic stub and restores it after — NO real network.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  parseVideoId,
  fetchYoutubeTranscript,
} from "../src/data-sources/youtube-transcript";

// ── fetch stub harness ─────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** Records every URL `fetch` was called with so we can assert SSRF behaviour. */
let fetchedUrls: string[] = [];

type Responder = (url: string) => {
  ok?: boolean;
  status?: number;
  body?: string;
  /** When true the responder rejects (simulates a network error / timeout abort). */
  throws?: boolean;
};

function installFetch(responder: Responder): void {
  fetchedUrls = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    fetchedUrls.push(url);
    const r = responder(url);
    if (r.throws) throw new Error("network");
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      text: async () => r.body ?? "",
    } as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ── helpers to build watch-page HTML + caption payloads ─────────────────────

/** A watch page embedding a captionTracks array. */
function watchHtml(tracks: Array<Record<string, unknown>>): string {
  return `<!doctype html><html><body><script>var x = {"captionTracks":${JSON.stringify(
    tracks,
  )},"audioTracks":[]};</script></body></html>`;
}

const JSON3_HELLO = JSON.stringify({
  events: [
    { segs: [{ utf8: "Hello" }, { utf8: " world" }] },
    { segs: [{ utf8: " from earnings call" }] },
  ],
});

// ── parseVideoId ────────────────────────────────────────────────────────────

describe("parseVideoId — URL shapes + bare id", () => {
  const ID = "dQw4w9WgXcQ";

  it("accepts a bare 11-char id", () => {
    assert.equal(parseVideoId(ID), ID);
  });

  it("watch?v=", () => {
    assert.equal(parseVideoId(`https://www.youtube.com/watch?v=${ID}`), ID);
    assert.equal(parseVideoId(`https://youtube.com/watch?v=${ID}&t=10s`), ID);
    assert.equal(parseVideoId(`https://m.youtube.com/watch?v=${ID}`), ID);
    assert.equal(parseVideoId(`https://music.youtube.com/watch?v=${ID}`), ID);
  });

  it("youtu.be/<id>", () => {
    assert.equal(parseVideoId(`https://youtu.be/${ID}`), ID);
    assert.equal(parseVideoId(`https://youtu.be/${ID}?si=abc`), ID);
  });

  it("/embed /shorts /live /v/", () => {
    assert.equal(parseVideoId(`https://www.youtube.com/embed/${ID}`), ID);
    assert.equal(parseVideoId(`https://www.youtube.com/shorts/${ID}`), ID);
    assert.equal(parseVideoId(`https://www.youtube.com/live/${ID}`), ID);
    assert.equal(parseVideoId(`https://www.youtube.com/v/${ID}`), ID);
  });

  it("nocookie host", () => {
    assert.equal(
      parseVideoId(`https://www.youtube-nocookie.com/embed/${ID}`),
      ID,
    );
  });

  it("loose `v=` fallback on a scheme-less fragment", () => {
    assert.equal(parseVideoId(`watch?v=${ID}`), ID);
    assert.equal(parseVideoId(`youtube.com/watch?v=${ID}`), ID);
  });

  it("returns null on junk / empty / wrong-length id", () => {
    assert.equal(parseVideoId(""), null);
    assert.equal(parseVideoId("   "), null);
    assert.equal(parseVideoId("not a url at all"), null);
    assert.equal(parseVideoId("https://www.youtube.com/"), null);
    assert.equal(
      parseVideoId("https://www.youtube.com/watch?v=tooSHORT"),
      null,
    );
    // @ts-expect-error — defensive: nullish input must not throw.
    assert.equal(parseVideoId(undefined), null);
  });

  it("SECURITY: a real URL on a NON-youtube host never yields an id", () => {
    // The 11-char token is present but the host is hostile — must be rejected,
    // not mined out via the loose fallback.
    assert.equal(parseVideoId(`https://evil.com/?v=${ID}`), null);
    assert.equal(parseVideoId(`https://evil.com/watch?v=${ID}`), null);
    assert.equal(parseVideoId(`https://notyoutube.com/embed/${ID}`), null);
    assert.equal(
      parseVideoId(`https://youtube.com.evil.com/watch?v=${ID}`),
      null,
    );
  });
});

// ── fetchYoutubeTranscript — happy paths ────────────────────────────────────

describe("fetchYoutubeTranscript — discovery + parsing", () => {
  const ID = "dQw4w9WgXcQ";

  it("rejects a non-11-char videoId before any fetch", async () => {
    installFetch(() => ({ body: "" }));
    const r = await fetchYoutubeTranscript("short");
    assert.equal(r, null);
    assert.equal(fetchedUrls.length, 0);
  });

  it("prefers the MANUAL English track over an ASR track (JSON3)", async () => {
    const manualUrl =
      "https://www.youtube.com/api/timedtext?v=ID&lang=en&manual=1";
    const asrUrl =
      "https://www.youtube.com/api/timedtext?v=ID&lang=en&kind=asr";
    installFetch((url) => {
      if (url.includes("/watch")) {
        return {
          body: watchHtml([
            { baseUrl: asrUrl, languageCode: "en", kind: "asr" },
            { baseUrl: manualUrl, languageCode: "en" },
          ]),
        };
      }
      // Only the manual track should be requested.
      if (url.startsWith(manualUrl)) return { body: JSON3_HELLO };
      return { body: "" };
    });

    const r = await fetchYoutubeTranscript(ID);
    assert.ok(r);
    assert.equal(r?.text, "Hello world from earnings call");
    assert.equal(r?.language, "en");
    // The ASR baseUrl must NOT have been fetched (manual preferred).
    assert.ok(!fetchedUrls.some((u) => u.startsWith(asrUrl)));
  });

  it("parses the legacy XML format + decodes entities", async () => {
    const trackUrl = "https://www.youtube.com/api/timedtext?v=ID&lang=en";
    installFetch((url) => {
      if (url.includes("/watch")) {
        return { body: watchHtml([{ baseUrl: trackUrl, languageCode: "en" }]) };
      }
      // JSON3 parse fails (not JSON) → falls back to XML <text> nodes.
      return {
        body:
          "<transcript>" +
          '<text start="0">Tom &amp; Jerry said &#39;hi&#39;</text>' +
          '<text start="1">price was &#8377;100</text>' +
          "</transcript>",
      };
    });

    const r = await fetchYoutubeTranscript(ID);
    assert.ok(r);
    assert.equal(r?.text, "Tom & Jerry said 'hi' price was ₹100");
  });

  it("falls back to the DIRECT timedtext endpoint when discovery is empty", async () => {
    installFetch((url) => {
      if (url.includes("/watch")) return { body: "<html>no captions</html>" };
      // The very first direct attempt (en, manual) returns JSON3.
      if (url.includes("/api/timedtext") && url.includes("lang=en")) {
        return { body: JSON3_HELLO };
      }
      return { body: "" };
    });

    const r = await fetchYoutubeTranscript(ID);
    assert.ok(r);
    assert.equal(r?.text, "Hello world from earnings call");
    // Confirms a direct youtube.com/api/timedtext URL was used.
    assert.ok(
      fetchedUrls.some((u) =>
        u.startsWith("https://www.youtube.com/api/timedtext"),
      ),
    );
  });

  it("returns null when the video has no captions anywhere", async () => {
    installFetch((url) => {
      if (url.includes("/watch")) return { body: "<html>nothing</html>" };
      return { ok: false, status: 404, body: "" };
    });
    const r = await fetchYoutubeTranscript(ID);
    assert.equal(r, null);
  });

  it("returns null on an empty/whitespace caption body", async () => {
    const trackUrl = "https://www.youtube.com/api/timedtext?v=ID&lang=en";
    installFetch((url) => {
      if (url.includes("/watch")) {
        return { body: watchHtml([{ baseUrl: trackUrl, languageCode: "en" }]) };
      }
      return { body: "   \n  " };
    });
    const r = await fetchYoutubeTranscript(ID);
    assert.equal(r, null);
  });
});

// ── SSRF guard ──────────────────────────────────────────────────────────────

describe("fetchYoutubeTranscript — SSRF guard on the discovered baseUrl", () => {
  const ID = "dQw4w9WgXcQ";

  it("NEVER fetches a poisoned baseUrl pointing at a non-youtube host", async () => {
    const evil = "https://evil.com/steal?cookie=1";
    installFetch((url) => {
      if (url.includes("/watch")) {
        return { body: watchHtml([{ baseUrl: evil, languageCode: "en" }]) };
      }
      // The ONLY source of caption data is the evil host. The legitimate direct
      // youtube.com fallbacks return nothing, so IF the evil URL were ever
      // fetched the transcript would be non-null — a leak the guard prevents.
      if (url.startsWith(evil)) return { body: JSON3_HELLO };
      return { body: "" };
    });

    const r = await fetchYoutubeTranscript(ID);
    // The evil host is never fetched → no caption data → degrade to null …
    assert.equal(r, null);
    // … and CRITICALLY the evil URL was never requested.
    assert.ok(
      !fetchedUrls.some((u) => u.startsWith("https://evil.com")),
      `evil baseUrl must not be fetched; fetched=${JSON.stringify(fetchedUrls)}`,
    );
  });

  it("rejects http:// and credential-smuggling caption hosts", async () => {
    const httpUrl = "http://www.youtube.com/api/timedtext?v=ID&lang=en";
    const credUrl = "https://user:pass@evil.com/api/timedtext?v=ID&lang=en";
    installFetch((url) => {
      if (url.includes("/watch")) {
        return {
          body: watchHtml([
            { baseUrl: httpUrl, languageCode: "en" },
            { baseUrl: credUrl, languageCode: "en" },
          ]),
        };
      }
      return { body: JSON3_HELLO };
    });

    await fetchYoutubeTranscript(ID);
    assert.ok(!fetchedUrls.some((u) => u.startsWith(httpUrl)));
    assert.ok(!fetchedUrls.some((u) => u.startsWith("https://user:pass@")));
  });

  it("DOES fetch an allowed googlevideo.com caption host", async () => {
    const gv = "https://r1---sn-abc.googlevideo.com/timedtext?v=ID&lang=en";
    installFetch((url) => {
      if (url.includes("/watch")) {
        return { body: watchHtml([{ baseUrl: gv, languageCode: "en" }]) };
      }
      if (url.startsWith(gv)) return { body: JSON3_HELLO };
      return { body: "" };
    });

    const r = await fetchYoutubeTranscript(ID);
    assert.ok(r);
    assert.equal(r?.text, "Hello world from earnings call");
    assert.ok(fetchedUrls.some((u) => u.startsWith(gv)));
  });
});

// ── timeout / abort handling ────────────────────────────────────────────────

describe("fetchYoutubeTranscript — timeout / network error degrades to null", () => {
  const ID = "dQw4w9WgXcQ";

  it("a timed-out (aborted) fetch resolves to null without throwing", async () => {
    // AbortSignal.timeout rejects the fetch with a TimeoutError — modelled here
    // as a throwing responder. The fetcher must catch it and degrade to null on
    // EVERY hop (watch page + all direct fallbacks).
    installFetch(() => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });

    const r = await fetchYoutubeTranscript(ID);
    assert.equal(r, null);
    // It did try (and each attempt was caught) — proves the abort path runs.
    assert.ok(fetchedUrls.length >= 1);
  });

  it("passes an AbortSignal to every fetch so a slow response is bounded", async () => {
    // The source must attach AbortSignal.timeout to each fetch (guarded). Assert
    // the signal is actually threaded through — that's what bounds a hung read.
    const seen: boolean[] = [];
    fetchedUrls = [];
    globalThis.fetch = (async (
      _input: unknown,
      init?: { signal?: AbortSignal },
    ) => {
      seen.push(init?.signal instanceof AbortSignal);
      return {
        ok: true,
        status: 200,
        text: async () => "",
      } as unknown as Response;
    }) as typeof fetch;

    await fetchYoutubeTranscript(ID);
    // AbortSignal.timeout exists in this runtime → every fetch must carry a signal.
    if (
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
    ) {
      assert.ok(seen.length >= 1);
      assert.ok(
        seen.every((s) => s === true),
        "every fetch must receive an AbortSignal (timeout guard)",
      );
    }
  });
});

// Touch the harness's setup hook so lint doesn't flag it unused.
beforeEach(() => {
  /* fetch is installed per-test via installFetch */
});
