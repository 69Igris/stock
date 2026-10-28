/**
 * Web RAG retrievers (MONEY-781).
 *
 * Concrete `Retriever` implementations over the Atlas vector store, behind the
 * shared `@usemoney/core/rag/retriever` interface. The chat RAG pipeline
 * (`rag.ts`) routes through `getUserRetriever()` / `getStockRetriever()` so a
 * future Vertex RAG retriever can be swapped in without touching call sites.
 *
 * Default behaviour is UNCHANGED: with no Vertex retriever supplied,
 * `selectRetriever` always returns the atlas retriever, which calls
 * `searchSimilar` / `searchStockDocuments` with identical arguments to before.
 */

import {
  selectRetriever,
  vertexRagReady,
  type Retriever,
  type RetrieveOptions,
} from "@usemoney/core/rag/retriever";
import { retrieveContexts } from "@usemoney/core/rag/vertex-rag";
import {
  searchSimilar,
  searchStockDocuments,
  type DocumentType,
  type SearchResult,
} from "./vector-store";

/**
 * Runtime-narrow the loosely-typed `RetrieveOptions.filter` bag (a
 * `Record<string, unknown>`) into the fields the atlas/vertex retrievers read.
 * Replaces blind `as` casts: a non-string `userId`/`symbol` becomes `""` (so the
 * caller short-circuits instead of querying with a coerced "[object Object]"),
 * `docTypes` is forwarded only when it's actually a string array, and `minScore`
 * only when it's a finite number. MONEY-807.
 */
function readFilter(filter: RetrieveOptions["filter"]): {
  userId: string;
  symbol: string;
  docTypes: DocumentType[] | undefined;
  minScore: number | undefined;
} {
  return {
    userId: typeof filter?.userId === "string" ? filter.userId : "",
    symbol: typeof filter?.symbol === "string" ? filter.symbol : "",
    docTypes:
      Array.isArray(filter?.docTypes) &&
      filter.docTypes.every((d) => typeof d === "string")
        ? (filter.docTypes as DocumentType[])
        : undefined,
    minScore:
      typeof filter?.minScore === "number" && Number.isFinite(filter.minScore)
        ? filter.minScore
        : undefined,
  };
}

/** Retrieves a user's own embedded documents (holdings, trades, scenarios…). */
export const atlasUserRetriever: Retriever<SearchResult> = {
  name: "atlas",
  ready: () => true,
  retrieve: async ({ query, topK, filter }: RetrieveOptions) => {
    const { userId, docTypes, minScore } = readFilter(filter);
    // No user = nothing to scope to. Short-circuit rather than calling
    // searchSimilar("", …) which would silently query an empty userId.
    if (!userId) return [];
    return searchSimilar(userId, query, { topK, docTypes, minScore });
  },
};

/** Retrieves stock-specific filing chunks from the shared system corpus. */
export const atlasStockRetriever: Retriever<SearchResult> = {
  name: "atlas",
  ready: () => true,
  retrieve: async ({ query, topK, filter }: RetrieveOptions) => {
    const { symbol, docTypes, minScore } = readFilter(filter);
    // No symbol = nothing to scope to. Short-circuit rather than searching the
    // shared corpus with an empty symbol.
    if (!symbol) return [];
    return searchStockDocuments(symbol, query, { topK, docTypes, minScore });
  },
};

/**
 * Maps a Vertex RAG `:retrieveContexts` result into the web `SearchResult`
 * shape so call sites stay identical to the atlas path. Shared by both Vertex
 * retrievers below. The managed corpus has no Mongo `_id`, so the source URI is
 * surfaced as a stable-ish `docId` + `metadata.sourceUrl` for citations.
 */
const toSearchResult = (
  c: { text: string; sourceUri: string | null; score: number },
  docType: DocumentType
): SearchResult => ({
  content: c.text,
  docType,
  docId: c.sourceUri ?? "",
  score: c.score,
  metadata: { sourceUrl: c.sourceUri ?? undefined },
});

/**
 * Vertex RAG retriever over a user's own documents (MONEY-782, P2b; MONEY-804 P3c).
 *
 * Gates itself on `vertexRagReady()` (flag + project + corpus). When the flag is
 * off it reports `ready: false`, so `selectRetriever` returns the atlas
 * retriever — ZERO behaviour change. `retrieve` degrades to `[]` on any error.
 */
export const vertexUserRetriever: Retriever<SearchResult> = {
  name: "vertex-rag",
  // SECURITY (MONEY-779 audit → MONEY-804): user-PRIVATE docs must never leak
  // across users from the shared managed corpus. This is now ENFORCED — the user
  // lane passes `userId` into `retrieveContexts`, which restricts the query to
  // that user's chunks via a `vertex_rag_store.filter.metadata_filter` predicate
  // (so a Vertex-backed user lane only ever sees the requesting user's docs). The
  // shared stock-filing corpus stays unscoped via `vertexStockRetriever`. Gated
  // on `vertexRagReady()` so it's still Atlas-by-default with the flag off.
  ready: vertexRagReady,
  retrieve: async ({ query, topK, filter }: RetrieveOptions) => {
    const { userId, minScore } = readFilter(filter);
    // No user = nothing safe to scope the user-private lane to. Short-circuit
    // rather than letting `retrieveContexts` query without a userId predicate
    // (which on the SHARED managed corpus would risk surfacing other users' docs).
    if (!userId) return [];
    // `retrieveContexts` scopes server-side by userId; `minScore` is a relevance
    // gate Vertex's `:retrieveContexts` does not accept, so apply it to the
    // mapped scores here to match the atlas retriever's contract. (docType
    // filtering is not part of the Vertex retrieveContexts surface, so it is not
    // forwarded — the managed corpus mixes types and the caller re-filters.)
    const contexts = await retrieveContexts(query, { topK, userId });
    return contexts
      .map((c) => toSearchResult(c, "filing"))
      .filter((r) => minScore === undefined || r.score >= minScore);
  },
};

/** Vertex RAG retriever over the shared stock filing corpus (MONEY-782, P2b). */
export const vertexStockRetriever: Retriever<SearchResult> = {
  name: "vertex-rag",
  ready: vertexRagReady,
  retrieve: async ({ query, topK, filter }: RetrieveOptions) => {
    // Same `minScore` post-filter parity as the user lane above. The stock corpus
    // is shared/unscoped, so no userId/symbol short-circuit applies here.
    const { minScore } = readFilter(filter);
    const contexts = await retrieveContexts(query, { topK });
    return contexts
      .map((c) => toSearchResult(c, "filing"))
      .filter((r) => minScore === undefined || r.score >= minScore);
  },
};

/** The active retriever for a user's own documents (atlas unless Vertex ready). */
export const getUserRetriever = (): Retriever<SearchResult> =>
  selectRetriever(atlasUserRetriever, vertexUserRetriever);

/** The active retriever for stock filing chunks (atlas unless Vertex ready). */
export const getStockRetriever = (): Retriever<SearchResult> =>
  selectRetriever(atlasStockRetriever, vertexStockRetriever);
