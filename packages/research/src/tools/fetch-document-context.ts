/**
 * Fetch Document Context — vector RAG over the system filing corpus (MONEY-613).
 *
 * The stock-document-embed worker chunks NSE filings / annual reports / concalls
 * and stores them in DocumentEmbedding under a shared SYSTEM_USER_ID (each chunk
 * prefixed "{SYMBOL} - {section}"). That corpus was consumed only by chat. This
 * tool brings TRUE vector RAG into research: it embeds the query with the shared
 * @usemoney/core generateEmbedding and semantic-searches the corpus for the
 * symbol's most relevant filing chunks, to ground the synthesis in primary
 * sources.
 *
 * Prod: MongoDB Atlas $vectorSearch. Dev / non-Atlas: in-memory cosine over the
 * symbol's chunks. Degrades to available:false (never throws) when GCP creds are
 * absent, the corpus isn't indexed yet, or Atlas search is unavailable.
 *
 * SEBI: returns sourced primary-document context only — no buy/sell/hold.
 */

import {
  selectRetriever,
  vertexRagReady,
  type Retriever,
  type RetrieveOptions,
} from "@usemoney/core/rag/retriever";
import { retrieveContexts } from "@usemoney/core/rag/vertex-rag";
import {
  buildVectorSearchStage,
  type EmbeddingsMode,
} from "@usemoney/core/embeddings-int8-logic";
import { findEmbeddingRows } from "@usemoney/core/embeddings-v2-read";
import { oid } from "@usemoney/core/embeddings-v2-write";
import { getEmbeddingsMode } from "@usemoney/core/embeddings-v2-mode";
import type { PrismaClient } from "@usemoney/database";
import type { ResearchToolDef, ToolOutput } from "./types";

/** Well-known system userId for the shared stock-document embeddings. */
const SYSTEM_USER_ID = "000000000000000000000001";

interface RagChunk {
  text: string;
  score: number;
  source: string;
  /** Real source URL (NSE attachment / filing) carried from the chunk metadata
   *  so research can surface a clickable citation, not a label. MONEY-670. */
  url?: string;
}

/**
 * The exact slice of the REAL Prisma client this retriever touches.
 *
 * `$runCommandRaw` ALONE since MONEY-1499: the cosine fallback used
 * `documentEmbedding.findMany`, and that cannot reach v2 — the vector there is
 * BSON BinData subtype 9, which Prisma's `Bytes` scalar neither writes nor
 * reads, so `DocumentEmbeddingV2` does not declare the field at all.
 * MONEY-807: typed as a `Pick` of `PrismaClient`
 * instead of a hand-rolled `RagPrisma` interface reached via a
 * `prisma as unknown as RagPrisma` double-cast — so a real method-signature
 * drift (renamed model, changed args) now fails at compile time.
 */
type RagPrisma = Pick<PrismaClient, "$runCommandRaw">;

/** Literal text for a Mongo `$regex`. See the call site for why. */
function escapeRegExp(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Atlas retriever over the shared system filing corpus (MONEY-781).
 *
 * Byte-identical to the previous inline logic, now behind the shared
 * `@usemoney/core/rag/retriever` interface so a Vertex RAG retriever (P2b) can
 * be swapped in via `selectRetriever`. The query is pre-embedded by the caller
 * and passed in as `queryVec`; `cosineSimilarity` is the same core helper.
 *
 * Prod: MongoDB Atlas `$vectorSearch`. On failure: in-memory cosine over the
 * symbol's chunks. `filter.symbol` scopes that fallback's substring match.
 *
 * MONEY-1499: `mode` decides v1 or v2 — the collection, the index, and whether
 * the query vector is a float array or int8 BinData. Both paths go through
 * `@usemoney/core`, so neither can be switched without the other.
 */
function makeAtlasRetriever(
  prisma: RagPrisma,
  queryVec: number[],
  cosineSimilarity: (a: number[], b: number[]) => number,
  mode: EmbeddingsMode,
): Retriever<RagChunk> {
  return {
    name: "atlas",
    ready: () => true,
    retrieve: async ({ topK = 6, filter }: RetrieveOptions) => {
      const symbol = String(filter?.symbol ?? "");
      let chunks: RagChunk[] = [];

      // Prod path: Atlas $vectorSearch over the system corpus.
      // MONEY-1499: which collection, which index, and whether the query
      // vector must be int8 BinData are ALL one decision, made in
      // `buildVectorSearchStage` so the three call sites in this repo cannot
      // disagree. `null` means the query vector would not quantize, which is
      // the same situation as having no query vector at all.
      const search = buildVectorSearchStage({
        mode,
        queryVector: queryVec,
        numCandidates: topK * 12,
        limit: topK * 3,
        // `oid()`, NOT a bare string — MONEY-1500. This is the PRIMARY path,
        // and it was returning ZERO rows on prod without throwing, so the
        // `catch` below never fired and the fallback F1 fixed was unreachable.
        // Measured: string -> 0 rows, {$oid} -> 6 rows, same index, same
        // vector, same `$runCommandRaw` transport.
        filter: { userId: oid(SYSTEM_USER_ID) },
      });
      try {
        if (!search) throw new Error("query vector did not quantize");
        const res = (await prisma.$runCommandRaw({
          aggregate: search.aggregate,
          pipeline: [
            search.stage,
            {
              $project: {
                content: 1,
                metadata: 1,
                score: { $meta: "vectorSearchScore" },
              },
            },
          ],
          cursor: {},
        })) as { cursor?: { firstBatch?: Array<Record<string, unknown>> } };

        const batch = res?.cursor?.firstBatch ?? [];
        chunks = batch.map((b) => {
          const md = (b.metadata ?? {}) as Record<string, unknown>;
          const url =
            typeof md.sourceUrl === "string" ? md.sourceUrl : undefined;
          const title = typeof md.title === "string" ? md.title : undefined;
          return {
            text: String(b.content ?? "").slice(0, 1500),
            score: typeof b.score === "number" ? b.score : 0,
            source: title ? `${title} · ${symbol}` : `Filing · ${symbol}`,
            url,
          };
        });
      } catch {
        // Fallback: cosine over the symbol's chunks only. NOT dev-only — in
        // prod this is what stands between a `$vectorSearch` failure and an
        // empty answer. It reads through `findEmbeddingRows` because under v2
        // the vector is BinData that Prisma's client cannot return at all.
        const { rows } = await findEmbeddingRows(
          (cmd) => prisma.$runCommandRaw(cmd as never),
          {
            mode,
            // `oid()`, NOT `{ $eq: <string> }` — MONEY-1499 review, F1.
            //
            // `userId` is `String @db.ObjectId`. Prisma COERCED the string when
            // this was `findMany({ where: { userId: SYSTEM_USER_ID } })`; a RAW
            // `find` does not, so a string here matches nothing — and matches
            // nothing FAST, because `@@index([userId])` returns an empty
            // candidate set immediately.
            //
            // This is the FALLBACK path: it runs when `$vectorSearch` throws
            // (index not yet queryable, an undeclared filter path, a transient
            // mongot error). Returning [] there means the research turn answers
            // with no filing context and no error, because the `catch` above
            // logs nothing. `embeddings-v2-write.ts` states the rule outright —
            // "`oid()` below is the only correct spelling and is exported so no
            // call site has to remember it". This was the one site that kept
            // the `$eq`-string spelling copied from the `$vectorSearch` stage.
            filter: {
              userId: oid(SYSTEM_USER_ID),
              // ESCAPED — MONEY-1499 review. `symbol` reaches here from an LLM
              // tool call, and the corpus this tool reads is scraped filing
              // text, so a prompt-injected document can steer it. Uppercasing
              // is not escaping: `(`, `[`, `+`, `*`, `\` and `{` all survive.
              // The Prisma call this replaced was `{ contains: symbol }`, which
              // the Mongo connector escapes for you; a raw `$regex` does not.
              // `A[` makes mongod reject the regex and THROW from inside the
              // `catch` block, escaping `retrieve()` as a raw parser error;
              // `(A+)+B` is a valid regex that backtracks exponentially over
              // 300 content fields, on the cluster serving the product, inside
              // a chat turn.
              content: { $regex: escapeRegExp(symbol) },
            },
            limit: 300,
          },
        );
        chunks = rows
          .map((d) => {
            const md = (d.metadata ?? {}) as Record<string, unknown>;
            const url =
              typeof md.sourceUrl === "string" ? md.sourceUrl : undefined;
            const title = typeof md.title === "string" ? md.title : undefined;
            return {
              text: String(d.content ?? "").slice(0, 1500),
              score: cosineSimilarity(queryVec, d.embedding),
              source: title ? `${title} · ${symbol}` : `Filing · ${symbol}`,
              url,
            };
          })
          .sort((a, b) => b.score - a.score);
      }

      return chunks;
    },
  };
}

/** Escape a value for embedding inside a CEL double-quoted string literal. */
function celString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Vertex RAG retriever over the managed corpus (MONEY-782, P2b).
 *
 * Gates itself on `vertexRagReady()` (flag + project + corpus), so with the flag
 * off it reports `ready: false` and `selectRetriever` returns the atlas
 * retriever — ZERO behaviour change. The managed `:retrieveContexts` endpoint
 * embeds the query server-side (no `queryVec` needed) and degrades to `[]` on
 * any error. Each context maps to a `RagChunk` carrying the source URI as the
 * clickable citation URL (MONEY-670 parity with the atlas path).
 *
 * SYMBOL SCOPING: the managed corpus is SHARED across symbols, so the query is
 * restricted server-side to the requested symbol via a
 * `metadata_filter` predicate (`symbol == "TCS"`). Without it the retriever
 * would surface other symbols' filings; the caller must therefore NOT fall back
 * to the unscoped chunk list on this path (see `execute`).
 */
const vertexRetriever: Retriever<RagChunk> = {
  name: "vertex-rag",
  ready: vertexRagReady,
  retrieve: async ({ query, topK = 6, filter }: RetrieveOptions) => {
    const symbol = String(filter?.symbol ?? "");
    // No symbol = nothing safe to scope to → return nothing rather than query
    // the shared corpus across every symbol.
    if (!symbol) return [];
    const contexts = await retrieveContexts(query, {
      topK,
      metadataFilter: `symbol == "${celString(symbol)}"`,
    });
    return contexts.map((c) => ({
      text: c.text,
      score: c.score,
      source: "Vertex RAG",
      url: c.sourceUri ?? undefined,
    }));
  },
};

export const fetchDocumentContextTool: ResearchToolDef = {
  name: "fetch_document_context",
  description:
    "Vector-search the embedded filing/annual-report/concall corpus for the chunks most relevant to a stock + query (RAG context to ground the synthesis in primary sources)",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (e.g., RELIANCE, TCS)",
      required: true,
    },
    query: {
      type: "string",
      description: "What to look for in the filings (defaults to the symbol)",
    },
    topK: {
      type: "number",
      description: "Max chunks to return",
      default: 6,
    },
  },
  cacheTTL: 900, // 15 min
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string"
        ? params.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase()
        : "";
    const query = (params.query as string) || symbol;
    const topK = Math.min((params.topK as number) || 6, 12);
    if (!symbol) return { success: false, error: "symbol is required" };

    try {
      const { generateEmbedding, cosineSimilarity } =
        await import("@usemoney/core/embeddings");
      const { default: prisma } = await import("@usemoney/database");

      const queryVec = await generateEmbedding(`${symbol}: ${query}`).catch(
        () => null,
      );
      if (!queryVec) {
        return {
          success: true,
          data: {
            available: false,
            symbol,
            reason:
              "Query embedding unavailable (missing GCP credentials or embedding quota); skipping RAG",
            chunks: [],
          },
        };
      }

      // Retrieve via the seam (MONEY-781/782). The query was pre-embedded above
      // for the atlas path; the Vertex backend embeds server-side. selectRetriever
      // returns atlas unless Vertex RAG is configured (flag off → atlas, unchanged).
      // No cast: the real default-exported PrismaClient is directly assignable
      // to the `RagPrisma` Pick, so any method-shape drift is caught here.
      const atlasRetriever = makeAtlasRetriever(
        prisma,
        queryVec,
        cosineSimilarity,
        await getEmbeddingsMode(),
      );
      const retriever = selectRetriever(atlasRetriever, vertexRetriever);
      const isVertex = retriever.name === "vertex-rag";
      const chunks: RagChunk[] = await retriever.retrieve({
        query: `${symbol}: ${query}`,
        topK,
        filter: { symbol },
      });

      // Keep symbol-relevant chunks first. The atlas corpus is SHARED across
      // symbols and only loosely scoped (dev `contains`), so it falls back to the
      // raw chunks when the text-substring match is empty. Vertex is scoped
      // server-side by `symbol == "..."`, so an empty result genuinely means "no
      // context for this symbol" — never fall back to the unscoped list there
      // (that would defeat the per-symbol filter), report available:false instead.
      const relevant = chunks.filter((c) =>
        c.text.toUpperCase().includes(symbol),
      );
      const candidates = relevant.length || isVertex ? relevant : chunks;
      const final = candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((c) => ({ ...c, score: Math.round(c.score * 1000) / 1000 }));

      if (final.length === 0) {
        return {
          success: true,
          data: {
            available: false,
            symbol,
            reason: `No embedded filing context for ${symbol} (the document corpus may not be indexed yet)`,
            chunks: [],
          },
        };
      }

      return {
        success: true,
        data: {
          available: true,
          symbol,
          chunkCount: final.length,
          chunks: final,
          // Source label reflects the retriever actually used (atlas vs Vertex),
          // not a hardcoded backend, so citations name the real provider.
          source: isVertex
            ? "Vertex AI RAG Engine (managed corpus, primary filings)"
            : "DocumentEmbedding vector search (Gemini text-embedding-004, primary filings)",
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Document RAG failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
