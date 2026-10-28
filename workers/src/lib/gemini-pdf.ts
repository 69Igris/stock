/**
 * Gemini PDF reader for the financials-parse lane — MONEY-1255.
 *
 * Hands a filed PDF to a Flash-tier Gemini model under a CONSTRAINED JSON
 * schema and returns the parsed reading. Lazy + graceful, mirroring
 * `lib/docai.ts`, which is the nearest sibling and the pattern this repo
 * already trusts:
 *
 *   - Nothing is constructed at import time and nothing throws at import time.
 *   - Every failure — unconfigured, oversized, timed out, refused, unparseable
 *     — DEGRADES to a typed result. This module NEVER throws.
 *
 * Why degrade rather than throw: the caller is a batch that must not lose the
 * other 24 documents to one bad PDF, and the failure KIND is what decides
 * whether the document is retried. A thrown error erases that distinction at
 * the first `catch`.
 *
 * ## Two transports, because the document has to reach the model either way
 *
 * Neither is a fallback for the other — they belong to the two BACKENDS
 * `getVertexAIClient` already chooses between, and picking the wrong one is a
 * hard failure rather than a degradation:
 *
 *   - **Developer API** (`GOOGLE_GENAI_API_KEY`, the primary backend since
 *     MONEY-650) → the **Files API**. Upload, wait for ACTIVE, reference by
 *     `fileUri`, delete. `ai.files.upload` THROWS on a Vertex client by
 *     design, so this path is gated on the key being present.
 *   - **Vertex fallback** (`GCP_PROJECT_ID`, no key) → the **gs:// URI
 *     directly**. Vertex reads GCS itself, so there is no upload at all and
 *     the bytes never need to leave the bucket.
 *
 * Inline base64 is deliberately NOT one of them. It caps the whole request at
 * 20 MB, which — measured against production — would have marked 1,917 of
 * 15,705 financial-statement PDFs (12.2%) UNSUPPORTED at a 12 MiB threshold.
 * That loss is BIASED, not random: a bigger annual report generally means a
 * bigger company, so an inline ceiling systematically drops the most valuable
 * names, quietly, as a status rather than an error.
 *
 * ## Configuration
 *
 *   DOC_PARSE_MODEL        optional override; must be a REGISTERED, available
 *                          model id or it is ignored (never sent to the API).
 *   DOC_PARSE_BUDGET_MS    optional per-document budget (upload + activate +
 *                          generate share ONE deadline — see below).
 *
 * `ANTHROPIC_API_KEY` is NOT consulted: the Claude router is founder-gated for
 * interactive surfaces and a background batch has no user to gate on.
 */

import { GoogleGenAI } from "@google/genai";
import { getVertexAIClient } from "@usemoney/core/gemini";
import {
  resolveChatModel,
  isModelAvailable,
  getModelDefinition,
} from "@usemoney/core/gemini/model-registry";
import {
  DOCUMENT_FINANCIALS_SCHEMA,
  type RawDocumentFinancials,
} from "@usemoney/core/market-data/document-financials-logic";
import {
  buildGenerationConfig,
  buildOnlineRequest,
  type DocRequestContext,
} from "./gemini-doc-request-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[gemini-pdf]", ...args),
  warn: (...args: unknown[]) => console.warn("[gemini-pdf]", ...args),
};

/**
 * The Files API's own per-file ceiling: 2 GiB. Recorded so the constant below
 * is visibly NOT this number — the binding constraint is ours, not Google's.
 */
export const FILES_API_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Largest PDF this job will attempt. 50 MiB.
 *
 * Bounded by LATENCY and PAGE COUNT rather than by the transport:
 *
 *   - The 600s Pub/Sub ack deadline is the hard ceiling on the whole run, and
 *     a document has to be downloaded from GCS, uploaded to the Files API, and
 *     then READ by a model whose cost scales with page count. The production
 *     tail is long — 34 of 15,705 documents exceed 50 MiB and one is 212 MiB —
 *     and a 212 MiB PDF is a latency risk long before it is a size problem.
 *   - Gemini's document understanding caps at 1,000 pages per PDF. A 212 MiB
 *     filing is far past that, so it would be truncated silently rather than
 *     read.
 *
 * At 50 MiB the loss is 34 documents (0.2%) instead of the 1,917 (12.2%) a
 * 12 MiB inline ceiling would have cost, and those 34 are genuine outliers
 * rather than a systematic bias toward large companies. They are marked
 * {@link DOC_PARSE_TOO_LARGE} → `UNSUPPORTED` and COUNTED, so the gap is a
 * number on a dashboard rather than an anecdote.
 */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/**
 * ONE deadline for the whole per-document model interaction — upload,
 * activation wait, and generation together.
 *
 * Three independent timeouts would be three independent worst cases that ADD,
 * and the batch's headroom arithmetic would then have to budget for their sum.
 * A single shared deadline makes the in-flight term ONE number that
 * `stock-document-parse-logic.ts` can subtract from 600s, which is what turns
 * that arithmetic from a hope into a bound.
 *
 * 240s covers: a 50 MiB upload (~60s on a slow link), activation (usually
 * instant for a PDF), and a Flash read of a several-hundred-page filing.
 * Whatever is left when one stage finishes is what the next stage gets.
 */
export const DEFAULT_DOC_PARSE_BUDGET_MS = 240_000;

/** How often the Files API is polled while a file is PROCESSING. */
export const FILE_ACTIVATION_POLL_MS = 1_000;

/**
 * Ceiling on the best-effort file DELETE, which runs OUTSIDE the parse budget.
 *
 * It has to be bounded by something or it is an unbounded term in the batch's
 * 600s arithmetic — the one place a "best effort, never mind" call can still
 * cost a redelivery. 10s is far more than a delete needs; exceeding it leaks
 * one object that expires on its own in 48h.
 */
export const FILE_DELETE_TIMEOUT_MS = 10_000;

/** Cap on output tokens. A 4-period reading with line items is large. */
export const DOC_PARSE_MAX_OUTPUT_TOKENS = 32_768;

/** Deterministic decoding: this is transcription, not composition. */
export const DOC_PARSE_TEMPERATURE = 0;

// ── Failure kinds. The CALLER routes on these, so they are values, not text ──

/** Gemini is not configured in this environment. Not the document's fault. */
export const DOC_PARSE_UNCONFIGURED = "UNCONFIGURED" as const;
/** Above {@link MAX_PDF_BYTES}. Deterministic — never retry as-is. */
export const DOC_PARSE_TOO_LARGE = "TOO_LARGE" as const;
/** The call failed (network, 5xx, upload, activation, timeout). Retryable. */
export const DOC_PARSE_CALL_FAILED = "CALL_FAILED" as const;
/** The call returned, but not JSON matching the schema. A PROMPT signal. */
export const DOC_PARSE_UNPARSEABLE = "UNPARSEABLE" as const;
/**
 * The model ran out of OUTPUT BUDGET mid-answer — MONEY-1334.
 *
 * Distinct from UNPARSEABLE, and the distinction decides what happens next.
 * Both produce text that will not parse, but their causes are opposite:
 * UNPARSEABLE is the MODEL answering with something we cannot read, which on
 * the markdown lane is worth one whole-PDF vision attempt; TRUNCATED is OUR
 * CEILING, which vision cannot fix because vision runs under the same ceiling
 * — it just costs a GCS download of up to 50 MiB, a Files API upload and a
 * second paid generation first.
 *
 * Measured in the MONEY-1332 pilot: 15 of 22 responses finished MAX_TOKENS and
 * 14 were cut off mid-JSON. Every one of those would have bought a vision retry
 * it could not benefit from, attributed in the logs to the model rather than to
 * our configuration.
 */
export const DOC_PARSE_TRUNCATED = "TRUNCATED" as const;

export type DocParseFailure =
  | typeof DOC_PARSE_UNCONFIGURED
  | typeof DOC_PARSE_TOO_LARGE
  | typeof DOC_PARSE_CALL_FAILED
  | typeof DOC_PARSE_UNPARSEABLE
  | typeof DOC_PARSE_TRUNCATED;

/** Per-call token accounting, so cost is measurable rather than estimated. */
export interface DocParseUsage {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  /** Thinking tokens. Billed at the OUTPUT rate and drawn from the same ceiling. */
  thinkingTokens: number;
  /**
   * How many of `promptTokens` were served from the implicit cache.
   *
   * MONEY-1314 — this is the ONLY observable that says whether the ~4,506-token
   * fixed prefix is actually earning its ~90% discount. The request succeeds
   * identically at full price, so a steady zero across a batch is invisible
   * everywhere else: no error, no warning, no failed row, just a bill roughly
   * 2.4x what the plan assumed.
   *
   * Absent on responses that carry no cache hit AND on models that do not
   * report it, so 0 means "not reported or not cached" — a run of zeros is a
   * reason to check, never proof on its own.
   */
  cachedTokens: number;
}

export interface DocParseResult {
  ok: boolean;
  /** The parsed reading. Present only when `ok`. */
  data: RawDocumentFinancials | null;
  /** Which model actually ran. Stamped onto every row it produces. */
  model: string;
  /** Which transport carried the document. */
  transport: "files-api" | "gcs-uri" | "inline-text" | "none";
  /** Token counts as the API reported them. Zeroed when the call never ran. */
  usage: DocParseUsage;
  /** Null when `ok`. */
  failure: DocParseFailure | null;
  /** Operator-facing detail. Never surfaced to a user. */
  error: string | null;
  /** Wall-clock milliseconds the whole interaction took. */
  elapsedMs: number;
}

/**
 * The model this lane runs on.
 *
 * Read from the REGISTRY (`@usemoney/core/gemini/model-registry`) rather than
 * hardcoded, so a model rename or deprecation moves in one place.
 * `resolveChatModel` is the fast/Flash lane — decision D-c — and it already
 * carries the availability fallback, so a de-listed id degrades to a live Flash
 * instead of 404ing at the API. PREMIUM is passed as the plan because this is a
 * system job with no user; it selects the best Flash model, not a Pro one.
 *
 * An override is honoured ONLY when the registry KNOWS the id AND reports it
 * available. An unknown id is IGNORED, not forwarded — handing an unregistered
 * string to the API turns a typo into a per-document 404 across the backlog.
 *
 * BOTH checks are required, and the first one is easy to leave out:
 * `isModelAvailable` returns TRUE for an id the registry has never heard of. It
 * consults `ENV_GATED_MODELS`, and an unknown id has no gate, so it falls
 * through to `return true`. It answers "is this id switched off?", not "is this
 * id real?" — so `isModelAvailable` ALONE would have forwarded
 * `gemini-9-turbo` verbatim. `getModelDefinition` is the registration check.
 */
export function resolveDocParseModel(override?: string | null): string {
  const raw = (override ?? process.env.DOC_PARSE_MODEL ?? "").trim();
  if (raw) {
    if (getModelDefinition(raw) && isModelAvailable(raw)) return raw;
    logger.warn(
      `DOC_PARSE_MODEL="${raw}" is not a registered/available model — ignoring it`,
    );
  }
  return resolveChatModel("PREMIUM");
}

/** The configured per-document budget. */
export function docParseBudgetMs(): number {
  const raw = Number(process.env.DOC_PARSE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DOC_PARSE_BUDGET_MS;
}

/** True when a Gemini backend is reachable at all (Developer API or Vertex). */
export function geminiPdfReady(): boolean {
  return (
    !!process.env.GOOGLE_GENAI_API_KEY?.trim() ||
    !!process.env.GCP_PROJECT_ID?.trim()
  );
}

/**
 * Which transport a given environment + document can use.
 *
 * Pure and exported so the routing is unit-testable without a client: the
 * failure it prevents ("the Files API throws on a Vertex client") is an
 * environment-dependent hard error, which is the kind this repo keeps
 * discovering in production rather than in a test.
 */
export function resolveTransport(
  env: Record<string, string | undefined> = process.env,
  gcsUri?: string | null,
): "files-api" | "gcs-uri" | "none" {
  if (env["GOOGLE_GENAI_API_KEY"]?.trim()) return "files-api";
  if (env["GCP_PROJECT_ID"]?.trim() && gcsUri?.trim()) return "gcs-uri";
  return "none";
}

function emptyUsage(): DocParseUsage {
  return {
    promptTokens: 0,
    candidatesTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    thinkingTokens: 0,
  };
}

function degraded(
  failure: DocParseFailure,
  error: string,
  model: string,
  transport: DocParseResult["transport"] = "none",
  elapsedMs = 0,
): DocParseResult {
  return {
    ok: false,
    data: null,
    model,
    transport,
    usage: emptyUsage(),
    failure,
    error,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// DEADLINE
// ---------------------------------------------------------------------------

/** A monotonic budget shared by every stage of one document's parse. */
export interface Deadline {
  /** Milliseconds left. Never negative. */
  remaining(): number;
  expired(): boolean;
}

export function createDeadline(
  budgetMs: number,
  now: () => number = Date.now,
): Deadline {
  const endsAt = now() + budgetMs;
  return {
    remaining: () => Math.max(0, endsAt - now()),
    expired: () => now() >= endsAt,
  };
}

/**
 * Race a promise against the remaining budget, ALWAYS clearing the timer.
 *
 * The `finally` is load-bearing, not tidiness: an uncleared `setTimeout` keeps
 * the event loop alive and turns a finished worker into an orphaned process
 * that the test runner reports as a hang. This repo has a standing rule that
 * tests must never orphan, and the source is where that is won.
 */
export async function withDeadline<T>(
  promise: Promise<T>,
  deadline: Deadline,
  label: string,
): Promise<T> {
  const ms = deadline.remaining();
  if (ms <= 0) throw new Error(`${label}: budget exhausted before it started`);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A cancellable sleep that never leaks its timer. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // Do not hold the process open on this alone.
    if (typeof t === "object" && t && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });
}

// ---------------------------------------------------------------------------
// RESPONSE READING
// ---------------------------------------------------------------------------

/**
 * Pull `usageMetadata` off a response without trusting its shape.
 *
 * Every field is coerced through `Number.isFinite`. A `NaN` token count summed
 * across a nightly batch produces a `NaN` cost report, which is the same
 * non-finite poisoning the figures themselves are guarded against — and a cost
 * number nobody can read is a cost nobody controls.
 */
export function readUsage(response: unknown): DocParseUsage {
  const meta = (response as { usageMetadata?: Record<string, unknown> })
    ?.usageMetadata;
  const n = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    promptTokens: n(meta?.["promptTokenCount"]),
    candidatesTokens: n(meta?.["candidatesTokenCount"]),
    totalTokens: n(meta?.["totalTokenCount"]),
    // Spelled `cachedContentTokenCount` by the API — NOT `cachedTokenCount`,
    // which is what the field is called in most write-ups of it. A wrong key
    // reads 0 forever through the same `n()` guard that protects a genuinely
    // absent one, so the two are indistinguishable at the call site.
    cachedTokens: n(meta?.["cachedContentTokenCount"]),
    // MONEY-1334 — thinking bills at the OUTPUT rate and shares the output
    // ceiling, so without this the single largest component of the bill is
    // invisible and the ceiling can only ever be re-chosen by guessing. Spelled
    // `thoughtsTokenCount`; a wrong key reads 0 forever through the same n()
    // guard that protects a genuinely absent one, which is exactly how
    // `cachedContentTokenCount` above earned its warning.
    thinkingTokens: n(meta?.["thoughtsTokenCount"]),
  };
}

/**
 * Why did generation stop? `MAX_TOKENS` is the one that changes our behaviour.
 *
 * On the CANDIDATE, never on the response — reading it a level up yields
 * undefined for every answer, healthy or not, which is indistinguishable from
 * "the vendor does not send it".
 */
export function readFinishReason(response: unknown): string | null {
  return (
    (response as { candidates?: Array<{ finishReason?: string }> })
      ?.candidates?.[0]?.finishReason ?? null
  );
}

/**
 * Concatenate the text parts of the first candidate.
 *
 * The compat layer overlays a `text` hybrid, but a schema-constrained response
 * can still arrive split across parts, so the parts are read directly rather
 * than relying on the getter.
 */
export function extractResponseText(response: unknown): string {
  const candidates = (
    response as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }
  )?.candidates;
  const parts = candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

/**
 * Parse the model's JSON answer into the raw reading shape.
 *
 * Tolerant of a fenced ```json block, because a constrained decode is a request
 * and not a guarantee. Returns null rather than throwing — an unparseable
 * answer is a PROMPT signal (`UNPARSEABLE`), categorically different from a
 * failed call, and the caller must be able to tell them apart.
 */
export function parseDocFinancialsJson(
  text: string,
): RawDocumentFinancials | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;

  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as RawDocumentFinancials;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FILES API
// ---------------------------------------------------------------------------

let filesClient: GoogleGenAI | null = null;
let filesClientInitialised = false;

/**
 * A raw `GoogleGenAI` bound to the Developer API key, used ONLY for file
 * management.
 *
 * Separate from `getVertexAIClient()` because the compat wrapper exposes only
 * `getGenerativeModel` — it has no `files` surface — and because reusing the
 * wrapper for generation keeps the backend selection, credential resolution and
 * location handling in the one place that is already tested.
 */
function getFilesClient(): GoogleGenAI | null {
  if (filesClientInitialised) return filesClient;
  filesClientInitialised = true;
  const apiKey = process.env.GOOGLE_GENAI_API_KEY?.trim();
  if (!apiKey) {
    filesClient = null;
    return null;
  }
  try {
    filesClient = new GoogleGenAI({ apiKey });
  } catch (err) {
    logger.warn(`Files client construction failed: ${errText(err)}`);
    filesClient = null;
  }
  return filesClient;
}

/** Test seam — drops the memoised Files client. */
export function resetGeminiPdfClients(): void {
  filesClient = null;
  filesClientInitialised = false;
}

/** An uploaded file's handle, reduced to what the caller needs. */
export interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

/**
 * Decide what to do with a file the API has just reported on.
 *
 * Pure, so the three outcomes are testable without an API: a FAILED activation
 * has to be distinguishable from a slow one, or a permanently-broken upload is
 * polled until the budget dies and then reported as a timeout — which reads as
 * transient and gets retried forever.
 */
export function classifyFileState(
  state: string | undefined,
): "ready" | "wait" | "failed" {
  if (state === "ACTIVE") return "ready";
  if (state === "FAILED") return "failed";
  // An absent state means the API did not say. Treat it as ready rather than
  // polling forever: the Files API omits `state` for small documents that were
  // active on arrival, and a genuinely unusable file fails at generate time
  // with a clear error instead of burning the budget here.
  if (!state || state === "STATE_UNSPECIFIED") return "ready";
  return "wait";
}

/**
 * Upload the bytes and wait until the file is usable.
 *
 * Bounded by the SHARED deadline at every step, including the poll loop — the
 * loop's exit condition is the deadline, not an iteration count, so it cannot
 * outlive the per-document budget however the API behaves.
 */
async function uploadAndActivate(
  ai: GoogleGenAI,
  bytes: Buffer,
  mimeType: string,
  displayName: string,
  deadline: Deadline,
): Promise<UploadedFile> {
  const uploaded = await withDeadline(
    ai.files.upload({
      file: new Blob([new Uint8Array(bytes)], { type: mimeType }),
      config: { mimeType, displayName },
    }),
    deadline,
    "files.upload",
  );

  const name = uploaded.name;
  const uri = uploaded.uri;
  if (!name || !uri) {
    throw new Error("files.upload returned no name/uri");
  }

  let state = classifyFileState(uploaded.state);
  let latestUri = uri;
  let latestMime = uploaded.mimeType || mimeType;

  while (state === "wait") {
    if (deadline.expired()) {
      throw new Error(`file ${name} never became ACTIVE within the budget`);
    }
    await sleep(FILE_ACTIVATION_POLL_MS);
    const refreshed = await withDeadline(
      ai.files.get({ name }),
      deadline,
      "files.get",
    );
    state = classifyFileState(refreshed.state);
    if (refreshed.uri) latestUri = refreshed.uri;
    if (refreshed.mimeType) latestMime = refreshed.mimeType;
  }

  if (state === "failed") {
    throw new Error(`file ${name} failed processing`);
  }

  return { name, uri: latestUri, mimeType: latestMime };
}

/**
 * Delete an uploaded file, best effort.
 *
 * Never throws and never consumes the parse budget. Files expire on their own
 * after 48h, so a failed delete costs quota rather than correctness — but a
 * throw here would turn a SUCCESSFUL parse into a failed one, which is the
 * expensive direction.
 */
async function deleteUploadedFile(
  ai: GoogleGenAI,
  name: string,
): Promise<void> {
  try {
    await withDeadline(
      ai.files.delete({ name }),
      createDeadline(FILE_DELETE_TIMEOUT_MS),
      "files.delete",
    );
  } catch (err) {
    logger.warn(`files.delete failed for ${name}: ${errText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// THE CALL
// ---------------------------------------------------------------------------

export interface ParsePdfFinancialsInput {
  /** The PDF bytes. Required for the Files API transport. */
  bytes: Buffer;
  /**
   * `gs://bucket/object` for the same document. Used by the Vertex transport,
   * which reads GCS directly and never uploads.
   */
  gcsUri?: string | null;
  /** The instruction, from `buildDocumentFinancialsPrompt`. */
  prompt: string;
  /** For logging and the uploaded file's display name. */
  label: string;
  mimeType?: string;
  modelOverride?: string | null;
  budgetMs?: number;
  /**
   * Disable model thinking on THIS lane too — MONEY-1334.
   *
   * `--disable-thinking` was wired through the markdown lane and silently
   * dropped here, so an arm the operator believed they were measuring ran with
   * thinking ON for every document that fell over to vision. An arm that is
   * half-applied is worse than one that is not offered: the report names a
   * configuration the run did not have.
   */
  disableThinking?: boolean;
}

/**
 * Read financial statements out of a PDF.
 *
 * NEVER throws. Every path returns a {@link DocParseResult} whose `failure`
 * tells the caller what to record: `TOO_LARGE`/`UNPARSEABLE` are deterministic
 * and must not be blind-retried, `CALL_FAILED` and `UNCONFIGURED` are transient
 * and should be.
 */
export async function parsePdfFinancials(
  input: ParsePdfFinancialsInput,
): Promise<DocParseResult> {
  const model = resolveDocParseModel(input.modelOverride);
  const mimeType = input.mimeType || "application/pdf";
  const transport = resolveTransport(process.env, input.gcsUri);

  if (transport === "none") {
    logger.warn(
      "No usable Gemini transport — set GOOGLE_GENAI_API_KEY, or GCP_PROJECT_ID with a gs:// URI",
    );
    return degraded(
      DOC_PARSE_UNCONFIGURED,
      "no Gemini transport is configured in this environment",
      model,
    );
  }

  if (transport === "files-api" && (!input.bytes || input.bytes.length === 0)) {
    return degraded(
      DOC_PARSE_UNPARSEABLE,
      "empty document bytes",
      model,
      transport,
    );
  }

  if (input.bytes && input.bytes.length > MAX_PDF_BYTES) {
    return degraded(
      DOC_PARSE_TOO_LARGE,
      `document is ${input.bytes.length} bytes, above the ${MAX_PDF_BYTES}-byte ceiling`,
      model,
      transport,
    );
  }

  const startedAt = Date.now();
  const deadline = createDeadline(input.budgetMs ?? docParseBudgetMs());
  let uploaded: UploadedFile | null = null;
  const filesAi = transport === "files-api" ? getFilesClient() : null;

  try {
    if (transport === "files-api") {
      if (!filesAi) {
        return degraded(
          DOC_PARSE_UNCONFIGURED,
          "Files client could not be constructed",
          model,
          transport,
        );
      }
      uploaded = await uploadAndActivate(
        filesAi,
        input.bytes,
        mimeType,
        input.label,
        deadline,
      );
    }

    const fileUri = uploaded ? uploaded.uri : input.gcsUri!;
    const fileMime = uploaded ? uploaded.mimeType : mimeType;

    const client = getVertexAIClient();
    const handle = client.getGenerativeModel({
      model,
      // ONE definition, shared with the markdown lane — MONEY-1334.
      //
      // This was an inline copy carrying `maxOutputTokens: 32_768` and NO
      // `thinkingConfig`, i.e. the exact unbounded-ceiling-with-dynamic-thinking
      // shape that truncated 15 of 22 answers on the other lane: thinking bills
      // at the OUTPUT rate and is drawn from this same ceiling, so leaving it
      // dynamic makes the ceiling its only bound.
      //
      // Vision reads MORE input than the markdown lane but produces the SAME
      // response schema, so the OUTPUT budget is the same question and gets the
      // same answer. A second copy of that reasoning is a second copy to drift.
      generationConfig: buildGenerationConfig({
        disableThinking: input.disableThinking,
      }),
    });

    const { response } = await withDeadline(
      handle.generateContent({
        contents: [
          {
            role: "user",
            parts: [
              { fileData: { fileUri, mimeType: fileMime } },
              { text: input.prompt },
            ],
          },
        ],
      }),
      deadline,
      `gemini pdf parse (${input.label})`,
    );

    const elapsedMs = Date.now() - startedAt;
    const result = assembleParseResult({ response, model, transport, elapsedMs });

    // One line per call, in a fixed shape, so cost is a query rather than an
    // estimate. `bytes` is here because the input-token count of a PDF is
    // driven by page count, and page count is not otherwise recorded anywhere.
    logger.info(
      `parsed ${input.label} model=${model} transport=${transport} ` +
        `bytes=${input.bytes?.length ?? 0} promptTokens=${result.usage.promptTokens} ` +
        `outputTokens=${result.usage.candidatesTokens} ` +
        `totalTokens=${result.usage.totalTokens} elapsedMs=${elapsedMs}`,
    );

    return result;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = errText(err);
    logger.warn(
      `parse failed for ${input.label} after ${elapsedMs}ms: ${message}`,
    );
    return degraded(
      DOC_PARSE_CALL_FAILED,
      message,
      model,
      transport,
      elapsedMs,
    );
  } finally {
    // Runs on EVERY exit, including the throw path — an upload that succeeded
    // and a generation that failed would otherwise leak a 50 MiB object into
    // the project's 20 GB Files quota once per failing document.
    if (filesAi && uploaded) await deleteUploadedFile(filesAi, uploaded.name);
  }
}

/**
 * Turn a model response into a {@link DocParseResult}.
 *
 * Shared by BOTH lanes. It was duplicated, and the duplication was not
 * cosmetic: a mutation that returned `ok: true` with empty `data` on
 * unparseable JSON survived the whole suite, because the branch is only
 * reachable behind a live client. Pulling it out makes the classification a
 * unit — the failure it prevents is a document recorded as "read, no
 * statements found" when the model in fact returned something we could not
 * read, and that verdict is terminal.
 */
export function assembleParseResult(args: {
  response: unknown;
  model: string;
  transport: DocParseResult["transport"];
  elapsedMs: number;
}): DocParseResult {
  const usage = readUsage(args.response);
  const data = parseDocFinancialsJson(extractResponseText(args.response));
  if (!data) {
    // ASK WHY IT WOULD NOT PARSE before calling it unreadable. A truncated
    // answer and a malformed one are the same empty string here, and they want
    // opposite dispositions — see DOC_PARSE_TRUNCATED.
    const finishReason = readFinishReason(args.response);
    const truncated = finishReason === "MAX_TOKENS";
    return {
      ok: false,
      data: null,
      model: args.model,
      transport: args.transport,
      usage,
      failure: truncated ? DOC_PARSE_TRUNCATED : DOC_PARSE_UNPARSEABLE,
      error: truncated
        ? `model ran out of output budget (finishReason=MAX_TOKENS, ` +
          `${usage.thinkingTokens} thinking + ${usage.candidatesTokens} visible ` +
          `tokens) — raise the ceiling, do not retry on vision`
        : `model response was not schema-shaped JSON` +
          (finishReason === null ? "" : ` (finishReason=${finishReason})`),
      elapsedMs: args.elapsedMs,
    };
  }
  return {
    ok: true,
    data,
    model: args.model,
    transport: args.transport,
    usage,
    failure: null,
    error: null,
    elapsedMs: args.elapsedMs,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// THE MARKDOWN LANE — MONEY-1314
// ---------------------------------------------------------------------------

/**
 * Read financial statements out of page-selected MARKDOWN.
 *
 * This is the primary lane for the backfill and for realtime ingest; the
 * whole-PDF vision path above is the RETRY, taken when this one fails its
 * arithmetic gate. Three differences from `parsePdfFinancials`, each of which
 * is the reason the lane exists:
 *
 *   NO UPLOAD. There is no Files API round trip, no 20 GB project quota to
 *   leak into, and no `finally` that has to delete a 50 MiB object. The text
 *   goes inline.
 *
 *   NO 50 MB CEILING. `MAX_PDF_BYTES` is Gemini's document limit, and the
 *   largest PDF in our corpus is 222.3 MB — over four times it. Those
 *   documents are markdown-or-nothing: the vision path cannot process them at
 *   all, in either direction, and returns TOO_LARGE forever.
 *
 *   CACHE-ORDERED PARTS. `buildOnlineRequest` puts the fixed prefix first, so
 *   ~48,000 requests share a 4,506-token leading span and implicit caching
 *   discounts it ~90%. The vision path cannot do this — its parts[0] is a
 *   `fileData` with a per-document URI, so consecutive requests share no
 *   prefix at all and no amount of prompt ordering changes that.
 *
 * NEVER throws, same contract as `parsePdfFinancials`: every path returns a
 * {@link DocParseResult} and the `failure` says whether a retry is worth
 * anything.
 */
export interface ParseMarkdownFinancialsInput {
  /** Page-selected markdown. Empty is UNPARSEABLE, not an empty success. */
  markdown: string;
  /** Which document this is — the variable tail after the cached prefix. */
  ctx: DocRequestContext;
  /** For logging. */
  label: string;
  modelOverride?: string | null;
  budgetMs?: number;
  /**
   * Measured to cut total tokens 32%. Off by default — see
   * `buildGenerationConfig`; the pilot decides, not a guess.
   */
  disableThinking?: boolean;
}

export async function parseMarkdownFinancials(
  input: ParseMarkdownFinancialsInput,
): Promise<DocParseResult> {
  const model = resolveDocParseModel(input.modelOverride);

  // A Gemini backend of ANY kind is enough here — unlike the vision path, this
  // lane needs no Files API and no gs:// URI, so `resolveTransport`'s
  // three-way answer does not apply. The one thing it cannot do without is a
  // client.
  if (!geminiPdfReady()) {
    return degraded(
      DOC_PARSE_UNCONFIGURED,
      "no Gemini backend is configured in this environment",
      model,
    );
  }

  // An empty selection is a FAILURE, never a successful parse of nothing. The
  // page selector returning zero pages and the converter producing no text are
  // different bugs, but both arrive here looking identical to a document that
  // genuinely holds no statements — and a silent empty success would write a
  // "we looked and found nothing" verdict over a document nobody read.
  if (!input.markdown || input.markdown.trim().length === 0) {
    return degraded(
      DOC_PARSE_UNPARSEABLE,
      "no markdown to read — the converter or the page selector produced nothing",
      model,
      "inline-text",
    );
  }

  const startedAt = Date.now();
  const deadline = createDeadline(input.budgetMs ?? docParseBudgetMs());

  try {
    const request = buildOnlineRequest({
      ctx: input.ctx,
      markdown: input.markdown,
      disableThinking: input.disableThinking,
    }) as {
      contents: unknown[];
      generationConfig: Record<string, unknown>;
    };

    const client = getVertexAIClient();
    const handle = client.getGenerativeModel({
      model,
      generationConfig: request.generationConfig,
    });

    const { response } = await withDeadline(
      // The compat wrapper's request type is narrower than what the API
      // accepts; `buildOnlineRequest` is the single definition of this shape
      // and is asserted against the PROBED batch line, so the cast is to the
      // wrapper's signature rather than around a real disagreement.
      handle.generateContent(
        { contents: request.contents } as Parameters<typeof handle.generateContent>[0],
      ),
      deadline,
      `gemini markdown parse (${input.label})`,
    );

    const elapsedMs = Date.now() - startedAt;
    const result = assembleParseResult({
      response,
      model,
      transport: "inline-text",
      elapsedMs,
    });

    // `cachedTokens` is the falsifiability of the whole prefix design. The
    // request succeeds identically whether or not the cache engaged, so a
    // steady zero here across thousands of documents means the discount is not
    // being applied and nothing else would ever say so.
    logger.info(
      `parsed ${input.label} model=${model} transport=inline-text ` +
        `mdChars=${input.markdown.length} promptTokens=${result.usage.promptTokens} ` +
        `cachedTokens=${result.usage.cachedTokens} ` +
        `outputTokens=${result.usage.candidatesTokens} ` +
        `totalTokens=${result.usage.totalTokens} elapsedMs=${elapsedMs}`,
    );

    return result;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    const message = errText(err);
    logger.warn(
      `markdown parse failed for ${input.label} after ${elapsedMs}ms: ${message}`,
    );
    return degraded(
      DOC_PARSE_CALL_FAILED,
      message,
      model,
      "inline-text",
      elapsedMs,
    );
  }
}
