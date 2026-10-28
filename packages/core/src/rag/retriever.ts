/**
 * Retriever seam (MONEY-781).
 *
 * A single, framework-agnostic interface for "given a query, return the most
 * relevant chunks". Both the web app (Atlas vector store) AND the research
 * package (system filing corpus) import this contract, which is WHY it lives in
 * `@usemoney/core` — `packages/research` cannot import `apps/web`.
 *
 * It is generic over the chunk type because each consumer's chunk shape differs
 * (web → `SearchResult`, research → its own `RagChunk`). The seam itself adds
 * ZERO behaviour: `selectRetriever` defaults to the atlas implementation unless
 * a Vertex RAG retriever is supplied AND reports ready.
 *
 * The Vertex RAG layer is HYBRID — it only ever swaps the retrieval layer here.
 * Text generation is unaffected.
 */

export interface RetrieveOptions {
  query: string;
  topK?: number;
  filter?: Record<string, unknown>;
}

export interface Retriever<TChunk = unknown> {
  /** Stable identifier for logging/telemetry (e.g. "atlas", "vertex-rag"). */
  readonly name: string;
  /** Whether this retriever is configured and safe to use right now. */
  ready(): boolean;
  /** Retrieve the most relevant chunks for the query. */
  retrieve(opts: RetrieveOptions): Promise<TChunk[]>;
}

/**
 * True when the Vertex RAG corpus is fully configured. Used by Vertex retriever
 * implementations to gate themselves (P2b). Defaults to false → atlas.
 */
export function vertexRagReady(): boolean {
  return (
    process.env.VERTEX_RAG_ENABLED === "true" &&
    !!process.env.GCP_PROJECT_ID &&
    !!process.env.VERTEX_RAG_CORPUS
  );
}

/**
 * Pick the Vertex retriever when supplied AND ready; otherwise fall back to the
 * atlas retriever. With no Vertex retriever (the current default), this is
 * always the atlas retriever — i.e. zero behaviour change.
 */
export function selectRetriever<T>(
  atlas: Retriever<T>,
  vertex?: Retriever<T>,
): Retriever<T> {
  return vertex && vertex.ready() ? vertex : atlas;
}
