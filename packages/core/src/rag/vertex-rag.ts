/**
 * Vertex AI RAG Engine backend (MONEY-782, P2b).
 *
 * The REST port of the RAG Engine — a fully-managed vector store + retrieval
 * that sits BEHIND the P2a `Retriever` seam. It is the optional second backend:
 * Atlas stays the default, and this layer only ever swaps the retrieval step
 * when `vertexRagConfigured()` is true (flag on + project + corpus). Text
 * generation is unaffected.
 *
 * Everything here is lazy + guarded and NEVER throws at import/build time. When
 * the project/corpus is unset (or any call fails), the REST client returns
 * `null` / `[]` and the caller falls back to atlas — i.e. zero behaviour change
 * with the flag off.
 *
 * Auth: `google-auth-library` GoogleAuth (cloud-platform scope) → an access
 * token sourced centrally via `googleCredentials()` (SA JSON on Vercel, an
 * attached SA / ADC on Cloud Run, or a key file locally). The token is fetched
 * per request (the auth client memoises + refreshes internally); the GoogleAuth
 * client itself is memoised for the life of the process.
 *
 * Endpoints (v1) are rooted at:
 *   https://{loc}-aiplatform.googleapis.com/v1/projects/{proj}/locations/{loc}
 *
 * Corpus selection: `VERTEX_RAG_CORPUS` holds the corpus resource name (or bare
 * id) the retriever uses. Set it from scripts/ops/setup-vertex-rag.sh after
 * creating the corpus.
 *
 * Scope: this module does RETRIEVAL (`:retrieveContexts`) AND a best-effort
 * single-file/GCS re-import (`ragFiles:import`) used by the embed worker to keep
 * the managed corpus fresh as new documents land (MONEY-804 P3c). One-time
 * corpus PROVISIONING + the initial bulk bucket import are still done by
 * scripts/ops/setup-vertex-rag.sh.
 *
 * SA-token note: `ragFiles:import` is a corpus WRITE method. RAG-Engine WRITE
 * methods reject end-user gcloud creds (ACCESS_TOKEN_TYPE_UNSUPPORTED) and
 * require a SERVICE-ACCOUNT token. `importFiles` below is therefore only useful
 * from a service-account runtime (Cloud Run worker with an attached SA, or a
 * key-file SA locally) — exactly where the embed worker runs. On an end-user
 * runtime the call simply fails the REST layer and degrades to a no-op, never
 * throwing. The bulk bucket import in setup-vertex-rag.sh stays the way to seed
 * the corpus the first time.
 *
 * Grounded-generation alternative (NOT implemented here): instead of a separate
 * `:retrieveContexts` call, Vertex can ground generation in one shot by passing
 *   tools: [{ retrieval: { vertexRagStore: {
 *     ragResources: [{ ragCorpus }], similarityTopK
 *   } } }]
 * on `generateContent`, then reading the cited chunks back from
 *   response.candidates[].groundingMetadata.groundingChunks[].retrievedContext
 * That couples retrieval to the generation model; we keep retrieval separate so
 * it slots cleanly behind the `Retriever` seam and Atlas/Vertex stay swappable.
 */

import { GoogleAuth } from "google-auth-library";

import { googleCredentials } from "../gemini/credentials";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cachedAuth: GoogleAuth | null = null;
let authInitialized = false;

/**
 * SSRF / URL-injection guards. Every request URL is built from env values
 * (`GCP_PROJECT_ID`, `VERTEX_RAG_LOCATION`, `VERTEX_RAG_CORPUS`) interpolated
 * into a template literal whose host is `https://{location}-aiplatform.
 * googleapis.com/...`. An unvalidated `location` like "evil.com/x?" would
 * produce `https://evil.com/x?-aiplatform.googleapis.com/...` — i.e. host
 * `evil.com` — and a crafted project/corpus could inject extra path segments
 * (`../`, a second `://`, `@`, `?`, `#`). We therefore constrain each segment
 * to a conservative token charset; anything else makes the value "invalid" so
 * the URL builders refuse to construct a request (return "" / null / []), and
 * the caller transparently falls back to atlas.
 *
 * - Region/location ids are lowercase alphanumerics + hyphens (GCP regions).
 * - Project ids are lowercase alphanumerics + hyphens (6-30 chars per GCP, but
 *   we only enforce the charset, not length, to avoid false negatives).
 * - A corpus id is digits/alphanumerics (RAG-Engine ids are numeric, but we
 *   allow underscores/hyphens defensively). The corpus may also arrive as a
 *   full `projects/{p}/locations/{l}/ragCorpora/{id}` name — that whole name is
 *   validated against a strict shape so it can never carry `..`, `@`, or a
 *   scheme.
 */
const SEGMENT_RE = /^[a-z0-9-]+$/;
const CORPUS_ID_RE = /^[a-zA-Z0-9_-]+$/;
const FULL_CORPUS_NAME_RE =
  /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/ragCorpora\/[a-zA-Z0-9_-]+$/;
/**
 * A userId safe to embed in a metadata-filter CEL predicate. Clerk ids are
 * `user_<base62>`; our internal Mongo ids are 24-char hex. Both fit this charset.
 * Anything else (quotes, spaces, CEL operators, backslashes) is REFUSED so the
 * per-user predicate can never be broken out of — the user lane then emits NO
 * scope and the retriever returns nothing (fail closed) rather than leaking the
 * shared corpus unfiltered.
 */
const USER_ID_RE = /^[A-Za-z0-9_-]+$/;

/** A region/project segment that is safe to interpolate into the request host/path. */
function isSafeSegment(value: string): boolean {
  return SEGMENT_RE.test(value);
}

/**
 * Final belt-and-braces check before an authenticated `fetch`: the URL must
 * parse, use https, and its host must be the regional Vertex AI host
 * (`*-aiplatform.googleapis.com` or `aiplatform.googleapis.com`). This is the
 * last line of defence so the bearer token can never be sent off-platform even
 * if an absolute URL slips through with a crafted host.
 */
function isVertexAiUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  return (
    host === "aiplatform.googleapis.com" ||
    host.endsWith("-aiplatform.googleapis.com")
  );
}

/** The GCP project id this backend targets (GCP_PROJECT_ID), or "" when unset. */
function project(): string {
  return process.env.GCP_PROJECT_ID?.trim() || "";
}

/** Vertex region for the RAG corpus (VERTEX_RAG_LOCATION), default us-central1. */
function location(): string {
  return process.env.VERTEX_RAG_LOCATION?.trim() || "us-central1";
}

/** The configured RAG corpus resource name / id (VERTEX_RAG_CORPUS), or "". */
export function ragCorpus(): string {
  return process.env.VERTEX_RAG_CORPUS?.trim() || "";
}

/**
 * True when the Vertex RAG backend is fully configured: the flag is on AND a
 * project AND a corpus are set. Mirrors `vertexRagReady()` in retriever.ts so
 * retriever implementations and this module gate on the same condition.
 */
export function vertexRagConfigured(): boolean {
  return (
    process.env.VERTEX_RAG_ENABLED === "true" &&
    project().length > 0 &&
    ragCorpus().length > 0
  );
}

/** Lazy GoogleAuth with the cloud-platform scope, or null when unconfigured. */
function getAuth(): GoogleAuth | null {
  if (authInitialized) return cachedAuth;
  authInitialized = true;

  if (!project()) {
    cachedAuth = null;
    return cachedAuth;
  }

  try {
    // Resolve creds centrally so the access token is minted from SA JSON on
    // Vercel/serverless, an attached SA / ADC on Cloud Run, or a key file locally.
    cachedAuth = new GoogleAuth({
      scopes: [CLOUD_PLATFORM_SCOPE],
      ...googleCredentials(),
    });
  } catch {
    cachedAuth = null;
  }

  return cachedAuth;
}

/**
 * Base v1 URL for the project's regional aiplatform endpoint, or "" when the
 * project/location env values fail the SSRF segment guard (so `rest()` refuses
 * the call rather than building a request to an attacker-chosen host/path).
 */
function apiBase(): string {
  const loc = location();
  const proj = project();
  if (!isSafeSegment(loc) || !isSafeSegment(proj)) return "";
  return `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}`;
}

/**
 * Resolve a corpus id or partial name to a fully-qualified resource name:
 *   projects/{proj}/locations/{loc}/ragCorpora/{id}
 * Accepts an already-full `projects/.../ragCorpora/{id}` name (passthrough), a
 * `ragCorpora/{id}` tail, or a bare id (defaulting to VERTEX_RAG_CORPUS).
 *
 * Returns "" when the result would be unsafe to interpolate into a request URL
 * (a passthrough name that isn't a strict `projects/.../ragCorpora/{id}` shape,
 * an unsafe project/location segment, or a corpus id with disallowed chars).
 * Callers treat "" as "not configured" and fall back to atlas.
 */
export function resolveCorpusName(corpus?: string): string {
  const value = (corpus ?? ragCorpus()).trim();

  // Full resource name → only pass through a strict, injection-free shape.
  if (value.startsWith("projects/")) {
    return FULL_CORPUS_NAME_RE.test(value) ? value : "";
  }

  const id = value.replace(/^.*ragCorpora\//, "");
  const proj = project();
  const loc = location();
  if (!CORPUS_ID_RE.test(id) || !isSafeSegment(proj) || !isSafeSegment(loc)) {
    return "";
  }
  return `projects/${proj}/locations/${loc}/ragCorpora/${id}`;
}

/** Fetch a bearer access token, or null when unconfigured / on failure. */
async function getAccessToken(): Promise<string | null> {
  const auth = getAuth();
  if (!auth) return null;
  try {
    const token = await auth.getAccessToken();
    return token ?? null;
  } catch {
    return null;
  }
}

/**
 * Authenticated JSON request against the aiplatform endpoint. Returns the parsed
 * body, or null when unconfigured / on a non-2xx response. NEVER throws — a
 * failed call always degrades to null so the caller falls back to atlas.
 *
 * `pathOrUrl` is normally a path appended to `apiBase()` (e.g.
 * ":retrieveContexts"). An absolute URL is also accepted but is gated through
 * `isVertexAiUrl()` so the bearer token can never be sent off-platform.
 */
async function rest<T>(
  pathOrUrl: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;

  let url: string;
  if (pathOrUrl.startsWith("http")) {
    // Absolute URL (corpus-scoped sub-resource): only ever target the regional
    // googleapis host. Anything else is refused so a poisoned env value can't
    // redirect the authenticated request off-platform.
    if (!isVertexAiUrl(pathOrUrl)) return null;
    url = pathOrUrl;
  } else {
    const base = apiBase();
    // Empty base = the project/location env failed the segment guard.
    if (!base) return null;
    url = `${base}${pathOrUrl}`;
  }

  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

    if (!res.ok) return null;

    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------------------
 * Retrieval — :retrieveContexts (managed vector search)
 * ------------------------------------------------------------------------- */

interface RetrieveContextsResponseContext {
  sourceUri?: string;
  sourceDisplayName?: string;
  text?: string;
  score?: number;
  distance?: number;
}

interface RetrieveContextsResponse {
  contexts?: {
    contexts?: RetrieveContextsResponseContext[];
  };
}

/** A single grounding context returned by the managed corpus. */
export interface VertexRetrievedContext {
  text: string;
  sourceUri: string | null;
  score: number;
}

/**
 * Per-user metadata-filter knobs for `retrieveContexts`.
 *
 * `userId` is the convenience path: when set, the request restricts the managed
 * corpus to chunks whose `userId` metadata equals it (so one user's query can
 * never surface another user's private docs from the SHARED corpus). `metadataFilter`
 * is the escape hatch — a raw RAG-Engine filter expression passed through verbatim
 * for callers that need a richer predicate; when both are given the explicit
 * `metadataFilter` wins.
 */
export interface RetrieveFilterOpts {
  userId?: string;
  metadataFilter?: string;
}

/**
 * The `rag_retrieval_config.filter` block for a `:retrieveContexts` request, or
 * `undefined` when no per-user / metadata scoping was requested.
 *
 * Vertex RAG Engine restricts managed-corpus retrieval by metadata via a filter
 * expression carried on `query.rag_retrieval_config.filter.metadata_filter` (a
 * CEL predicate over the chunk metadata attached at import time, e.g.
 * `userId == "abc"`). We expose two ways in:
 *   - `userId` → we synthesise `userId == "<id>"` (the common per-user case).
 *   - `metadataFilter` → a verbatim passthrough for any other predicate.
 * If the exact server-side field shape ever changes, this is the ONE place to
 * adjust; everything else (and the test) goes through it.
 *
 * SECURITY (fail closed): the per-user `userId` path only emits a predicate when
 * the id matches `USER_ID_RE`. An id with quotes / backslashes / spaces / CEL
 * operators returns `undefined` (NO scope) — the caller then refuses to query a
 * Vertex-backed PER-USER corpus rather than send it unscoped, so a malformed id
 * can never widen a single-user query to the whole shared corpus.
 *
 * Pure (no I/O), so the request-body mapping is unit-testable.
 */
export function buildMetadataFilter(
  opts: RetrieveFilterOpts = {},
): { metadata_filter: string } | undefined {
  // Explicit raw expression wins over the userId convenience.
  const explicit = opts.metadataFilter?.trim();
  if (explicit) return { metadata_filter: explicit };

  const userId = opts.userId?.trim();
  if (!userId) return undefined;

  // Fail closed: refuse to synthesise a predicate from an unsafe id (the caller
  // then emits no per-user scope rather than querying the shared corpus open).
  if (!USER_ID_RE.test(userId)) return undefined;

  // Defensive escaping (the charset guard already excludes both): a backslash
  // first (so it can't escape our own quote escape), then the double-quote, so
  // the CEL string literal can never be broken out of.
  const safe = userId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return { metadata_filter: `userId == "${safe}"` };
}

/**
 * Build the `:retrieveContexts` request body. Pure (no I/O) so the request-shape
 * mapping — including the optional per-user metadata filter — is unit-testable
 * without touching auth/fetch.
 *
 * Contract (RetrieveContextsRequest): the corpus selector is the only thing on
 * `vertex_rag_store`; `top_k` and the metadata `filter` belong on
 * `query.rag_retrieval_config.{top_k, filter.metadata_filter}` — NOT on
 * `vertex_rag_store`, where Vertex silently ignores them (so a per-user filter
 * placed there would be a no-op = a cross-user leak on a shared corpus). A
 * `rag_retrieval_config` block is emitted only when a `top_k` or `filter` is
 * present, so flag-off / shared-corpus callers send a body with just the corpus
 * selector + query text (byte-identical to the pre-filter path).
 */
export function buildRetrieveContextsBody(
  corpusName: string,
  query: string,
  opts: { topK?: number } & RetrieveFilterOpts = {},
): Record<string, unknown> {
  const filter = buildMetadataFilter(opts);
  const ragRetrievalConfig: Record<string, unknown> = {
    ...(typeof opts.topK === "number" ? { top_k: opts.topK } : {}),
    // Only present when a user/metadata scope was requested → flag-off and
    // shared-corpus (no userId) callers send the exact same body as before.
    ...(filter ? { filter } : {}),
  };
  return {
    vertex_rag_store: {
      rag_resources: [{ rag_corpus: corpusName }],
    },
    query: {
      text: query,
      ...(Object.keys(ragRetrievalConfig).length > 0
        ? { rag_retrieval_config: ragRetrievalConfig }
        : {}),
    },
  };
}

/**
 * Map the raw `:retrieveContexts` response body into the public
 * `VertexRetrievedContext[]` shape. Pure (no I/O) so it is unit-testable.
 */
export function mapRetrieveContextsResponse(
  body: RetrieveContextsResponse | null,
): VertexRetrievedContext[] {
  const contexts = body?.contexts?.contexts ?? [];
  return contexts.map((c) => ({
    text: c.text ?? "",
    sourceUri: c.sourceUri ?? c.sourceDisplayName ?? null,
    // Vertex returns a distance for some configs; convert to a similarity-ish
    // score. A distance can exceed 1 (e.g. cosine distance up to 2), so clamp
    // `1 - distance` to >= 0 — a negative "similarity" is meaningless and would
    // sort below / fail a minScore gate inconsistently downstream.
    score:
      typeof c.score === "number"
        ? c.score
        : typeof c.distance === "number"
          ? Math.max(0, 1 - c.distance)
          : 0,
  }));
}

/**
 * Retrieve grounding contexts from a corpus via the managed
 * `:retrieveContexts` endpoint. Returns `[{ text, sourceUri, score }]`.
 *
 * `corpus` defaults to VERTEX_RAG_CORPUS. When `userId` (or an explicit
 * `metadataFilter`) is supplied the managed-corpus query is restricted to that
 * user's chunks via a `query.rag_retrieval_config.filter.metadata_filter`
 * predicate — so a Vertex-backed PER-USER lane can never surface another user's
 * docs. Omitting both keeps the body byte-identical to the shared-corpus path
 * (no filter).
 *
 * SECURITY (fail closed): if a `userId` is supplied but no metadata filter could
 * be built from it (an id that fails the safe-charset guard, and no explicit
 * `metadataFilter` to fall back on), we return `[]` rather than query the SHARED
 * corpus unscoped — a malformed id must never widen a single-user lane.
 *
 * Returns `[]` when Vertex RAG is unconfigured / no corpus is set / the call
 * fails (never throws).
 */
export async function retrieveContexts(
  query: string,
  opts: { corpus?: string; topK?: number } & RetrieveFilterOpts = {},
): Promise<VertexRetrievedContext[]> {
  const corpus = opts.corpus ?? ragCorpus();
  if (!corpus) return [];

  const corpusName = resolveCorpusName(corpus);
  // "" = the corpus/project/location failed the SSRF guard → fall back to atlas.
  if (!corpusName) return [];

  // Fail closed: a per-user query whose id can't produce a scope must NOT run
  // unfiltered against the shared corpus.
  if (opts.userId !== undefined && !buildMetadataFilter(opts)) return [];

  const body = await rest<RetrieveContextsResponse>(":retrieveContexts", {
    method: "POST",
    body: buildRetrieveContextsBody(corpusName, query, {
      topK: opts.topK,
      userId: opts.userId,
      metadataFilter: opts.metadataFilter,
    }),
  });

  return mapRetrieveContextsResponse(body);
}

/* ----------------------------------------------------------------------------
 * Ingestion — ragFiles:import (best-effort corpus re-import) — MONEY-804 P3c
 * ------------------------------------------------------------------------- */

/**
 * Best-effort import of one or more GCS objects into a managed RAG corpus.
 *
 * Used by the embed worker so the managed corpus stays fresh as new stock
 * documents land (the P3c re-import loop): after a doc is embedded into Atlas
 * the worker ALSO points the corpus at the doc's `gs://…` object here. The
 * initial bulk bucket import is still done once by setup-vertex-rag.sh.
 *
 * SA-token note (see file header): `ragFiles:import` is a corpus WRITE method —
 * it needs a SERVICE-ACCOUNT token (end-user gcloud creds are rejected with
 * ACCESS_TOKEN_TYPE_UNSUPPORTED). It is therefore only meaningful from an
 * SA-backed runtime (the Cloud Run worker / a local key file); elsewhere the
 * REST layer fails and the call degrades to `false`.
 *
 * NEVER throws: returns `false` when unconfigured / no usable URIs / the call
 * fails, `true` on a 2xx. Vertex starts an LRO; we don't poll it (fire-and-
 * forget — the next retrieval simply sees the new chunks once it finishes).
 *
 * @param corpus    corpus resource name / bare id (defaults to VERTEX_RAG_CORPUS)
 * @param gcsUris   `gs://bucket/object` URIs to import (non-gs entries are dropped)
 */
export async function importFiles(
  corpus: string | undefined,
  gcsUris: string[],
): Promise<boolean> {
  const corpusName = resolveCorpusName(corpus);
  // "" = corpus/project/location failed the SSRF guard → no-op.
  if (!corpusName) return false;

  // Only ever hand Vertex gs:// URIs; silently drop anything else so a bad
  // caller value can't widen the import surface.
  const uris = gcsUris.filter(
    (u) => typeof u === "string" && u.startsWith("gs://"),
  );
  if (uris.length === 0) return false;

  const base = apiBase();
  // "" = the project/location env failed the segment guard → no-op.
  if (!base) return false;

  // ragFiles:import is rooted at the corpus resource, not at apiBase(). The
  // corpus name is itself `projects/{p}/locations/{l}/ragCorpora/{id}` (already
  // SSRF-validated by resolveCorpusName), so build the absolute host+path and
  // let rest()'s isVertexAiUrl() gate it as a final belt-and-braces check.
  const host = base.slice(0, base.indexOf("/v1/"));
  const url = `${host}/v1/${corpusName}/ragFiles:import`;

  const res = await rest<unknown>(url, {
    method: "POST",
    body: { importRagFilesConfig: { gcsSource: { uris } } },
  });

  return res !== null;
}

/** Test seam: clear the memoized GoogleAuth client (mirrors the auth latch). */
export function resetVertexRagAuth(): void {
  cachedAuth = null;
  authInitialized = false;
}
