/**
 * Gemini grounding-metadata PARSER tests (MONEY-587, task #39).
 *
 * Covers the pure `parseGroundingMetadata` function — feed mock Vertex
 * `groundingMetadata` objects and assert that:
 *   - groundingChunks[].web.{uri,title} map to typed sources
 *   - sources de-dupe by uri (first occurrence wins, keeps its [i])
 *   - 1-based [i] citation indices are assigned in first-seen order
 *   - groundingSupports[].segment.text supplies per-source snippets
 *   - webSearchQueries[] pass through
 *   - non-web (retrievedContext) and empty/odd shapes degrade gracefully
 *
 * Pure — no network, no Vertex call. `grounding.ts` has no import-time side
 * effects (the Vertex client is lazy in client.ts), so the real module loads
 * cleanly under tsx.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGroundingMetadata } from "@/lib/gemini/grounding";

describe("parseGroundingMetadata (MONEY-587)", () => {
  it("returns empty result for undefined/null metadata", () => {
    assert.deepEqual(parseGroundingMetadata(undefined), {
      sources: [],
      queries: [],
    });
    assert.deepEqual(parseGroundingMetadata(null), {
      sources: [],
      queries: [],
    });
  });

  it("maps web grounding chunks to typed, citation-indexed sources", () => {
    const { sources, queries } = parseGroundingMetadata({
      webSearchQueries: ["reliance q4 results 2026"],
      groundingChunks: [
        {
          web: {
            uri: "https://www.moneycontrol.com/news/reliance-q4",
            title: "Reliance Q4 net profit rises",
          },
        },
        {
          web: {
            uri: "https://economictimes.indiatimes.com/reliance",
            title: "RIL revenue beats estimates",
          },
        },
      ],
    });

    assert.equal(sources.length, 2);
    assert.deepEqual(queries, ["reliance q4 results 2026"]);

    // First-seen 1-based [i] indices.
    assert.equal(sources[0]!.i, 1);
    assert.equal(sources[1]!.i, 2);

    // Title + domain derivation.
    assert.equal(sources[0]!.title, "Reliance Q4 net profit rises");
    assert.equal(sources[0]!.domain, "moneycontrol.com");
    assert.equal(sources[0]!.source, "moneycontrol.com");
    assert.equal(
      sources[0]!.url,
      "https://www.moneycontrol.com/news/reliance-q4"
    );
    assert.equal(sources[1]!.domain, "economictimes.indiatimes.com");
  });

  it("de-dupes sources by uri and keeps the first [i]", () => {
    const { sources } = parseGroundingMetadata({
      groundingChunks: [
        { web: { uri: "https://example.com/a", title: "A" } },
        { web: { uri: "https://example.com/b", title: "B" } },
        // Duplicate of the first uri — must NOT add a new source.
        { web: { uri: "https://example.com/a", title: "A again" } },
      ],
    });

    assert.equal(sources.length, 2);
    assert.equal(sources[0]!.url, "https://example.com/a");
    assert.equal(sources[0]!.title, "A"); // first occurrence wins
    assert.equal(sources[0]!.i, 1);
    assert.equal(sources[1]!.i, 2);
  });

  it("attaches snippets from groundingSupports by chunk index", () => {
    const { sources } = parseGroundingMetadata({
      groundingChunks: [
        { web: { uri: "https://src1.com/x", title: "Source 1" } },
        { web: { uri: "https://src2.com/y", title: "Source 2" } },
      ],
      groundingSupports: [
        {
          segment: { text: "Net profit rose 12% YoY." },
          groundingChunkIndices: [0],
        },
        {
          segment: { text: "Revenue was flat sequentially." },
          groundingChunkIndices: [1],
        },
      ],
    });

    assert.equal(sources[0]!.snippet, "Net profit rose 12% YoY.");
    assert.equal(sources[1]!.snippet, "Revenue was flat sequentially.");
  });

  it("falls back to the domain when a chunk has no title", () => {
    const { sources } = parseGroundingMetadata({
      groundingChunks: [{ web: { uri: "https://www.livemint.com/markets" } }],
    });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.title, "livemint.com");
    assert.equal(sources[0]!.domain, "livemint.com");
  });

  it("skips non-web (retrievedContext) and empty chunks", () => {
    const { sources } = parseGroundingMetadata({
      groundingChunks: [
        // RAG/retrieval chunk — no web.uri, must be skipped.
        {
          retrievedContext: {
            uri: "gs://bucket/doc.pdf",
            title: "Internal doc",
          },
        },
        // Web chunk with empty uri — skipped.
        { web: { uri: "", title: "Empty" } },
        // Valid web chunk — kept, becomes [1].
        { web: { uri: "https://reuters.com/article", title: "Reuters" } },
      ],
    });
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.i, 1);
    assert.equal(sources[0]!.domain, "reuters.com");
  });

  it("filters out non-string web search queries", () => {
    const { queries } = parseGroundingMetadata({
      // Cast through unknown — Vertex only ever sends strings, but the parser
      // must defensively drop anything that isn't a non-empty string.
      webSearchQueries: ["valid query", "", 42, null] as unknown as string[],
      groundingChunks: [],
    });
    assert.deepEqual(queries, ["valid query"]);
  });
});
