/**
 * Stock Document Embedding Processor
 *
 * Reads StockDocument records with textContent, chunks them into
 * semantically meaningful sections, generates Gemini embeddings,
 * and stores in DocumentEmbedding for RAG vector search.
 *
 * Uses SYSTEM_USER_ID so embeddings are shared across all users.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import type { StockDocumentEmbedMessage } from "@usemoney/types/pubsub";
import { getEmbeddingModel } from "@usemoney/core/embeddings";
import { writeTargets } from "@usemoney/core/embeddings-int8-logic";
import { getEmbeddingsMode } from "@usemoney/core/embeddings-v2-mode";
import {
  deleteEmbeddingsV2,
  oid,
  upsertEmbeddingsV2,
  type EmbeddingUpsert,
} from "@usemoney/core/embeddings-v2-write";
import { generateBatchEmbeddings } from "../lib/embeddings";
import { downloadFromGCS } from "../lib/gcs";
import {
  SYSTEM_USER_ID,
  DELAY_BETWEEN_BATCHES_MS,
  chunkByDocType,
  buildEmbedQuery,
  shouldSkipDocument,
  gcsUriForDocument,
} from "./stock-document-embed-logic";
// MONEY-804 (P3c) - managed Vertex corpus re-import loop. Strictly behind
// `vertexRagConfigured()`: Atlas is the primary store and this is INERT (never
// even resolves the corpus) when the flag is off — zero behaviour change.
import {
  vertexRagConfigured,
  ragCorpus,
  importFiles,
} from "@usemoney/core/rag/vertex-rag";
// MONEY-783 - over-cap extracted docs carry their FULL text in a derived GCS
// sidecar (textContent only holds a capped preview). Probe for it so embeddings
// cover the whole document, not just the first MAX_TEXT_LENGTH chars. MONEY-779
// perf: MAX_TEXT_LENGTH gates the sidecar probe to over-cap PDFs only.
import {
  extractedSidecarPath,
  MAX_TEXT_LENGTH,
} from "./stock-document-extract-logic";
// MONEY-798 (P3c) - corpus-coverage visibility: log embedded/total per symbol at
// batch completion so RAG corpus health is observable in the worker logs.
import { getRagCoverage } from "@usemoney/research/data-sources/rag-enqueue";

/**
 * !! RE-EMBED CUTOVER (MONEY-619 Phase 5) !!
 *
 * Embeddings are env-gated: getEmbeddingModel() returns "text-embedding-004"
 * by default and "gemini-embedding-001" when USE_GEMINI_EMBEDDING_001=true.
 * Both are 768-dim, so the Atlas vector index shape is preserved.
 *
 * However the two are DIFFERENT embedding spaces — a single Atlas vector index
 * must not contain a mix of 004 and 001 vectors or cosine similarity is
 * garbage. Therefore flipping USE_GEMINI_EMBEDDING_001=true is a COORDINATED
 * cutover that REQUIRES re-embedding every DocumentEmbedding row:
 *   1. Flip the flag in all envs that share the index.
 *   2. Re-run this processor with `forceReindex: true` over the full stock
 *      corpus, and re-index user/document embeddings (document-process,
 *      vector-store indexer) so no 004 rows remain.
 * Each row is tagged with `embeddingModel: getEmbeddingModel()` so a partially
 * migrated index is detectable. Do NOT run a backfill from here automatically.
 */

const logger = {
  info: (...args: unknown[]) => console.log("[stock-doc-embed]", ...args),
  warn: (...args: unknown[]) => console.warn("[stock-doc-embed]", ...args),
  error: (...args: unknown[]) => console.error("[stock-doc-embed]", ...args),
};

// ============== Main Processor ==============
// Section-aware chunking, the embed-query builder, the constants and the
// min-length skip live in ./stock-document-embed-logic (imported above) so the
// test asserts the real shipped code instead of a drifted inline copy.

/** One row as this processor reads it — the exact `select` below. */
interface EmbedCandidate {
  id: string;
  symbol: string;
  docType: string;
  period: string;
  title: string;
  textContent: string | null;
  gcsPath: string;
  mimeType: string | null;
  sourceUrl: string | null;
}

/**
 * The three collaborators, injectable — MONEY-1328.
 *
 * Defaults ARE the production path, so the route and the pull subscriber pass
 * nothing. Narrow on purpose: with `findDocuments` and `generateEmbeddings`
 * replaced, the idle exit, the all-too-short exit and the
 * backend-refused-everything THROW are all reachable with NO Prisma handle and
 * NO embedding backend — the storage upsert is never entered on any of them,
 * because a document that stored nothing never gets that far.
 */
export interface StockDocumentEmbedDeps {
  findDocuments?: (args: {
    where: ReturnType<typeof buildEmbedQuery>;
    take: number;
  }) => Promise<EmbedCandidate[]>;
  generateEmbeddings?: typeof generateBatchEmbeddings;
  reportOutcome?: typeof reportJobOutcome;
  /** Inter-document pacing, in ms. Tests pass 0. Defaults to the real delay. */
  delayBetweenDocumentsMs?: number;
}

export async function processStockDocumentEmbed(
  message: StockDocumentEmbedMessage,
  deps: StockDocumentEmbedDeps = {},
): Promise<void> {
  const { symbols, forceReindex = false, batchSize = 200, docTypes } = message;
  const report = deps.reportOutcome ?? reportJobOutcome;
  const embedBatch = deps.generateEmbeddings ?? generateBatchEmbeddings;
  const documentDelayMs =
    deps.delayBetweenDocumentsMs ?? DELAY_BETWEEN_BATCHES_MS;

  logger.info(
    `Starting stock document embedding (force: ${forceReindex}, batch: ${batchSize})`,
  );

  // Query unembedded documents with text content.
  const where = buildEmbedQuery({ forceReindex, symbols, docTypes });

  const documents: EmbedCandidate[] = deps.findDocuments
    ? await deps.findDocuments({ where, take: batchSize })
    : await prisma.stockDocument.findMany({
        where,
        select: {
          id: true,
          symbol: true,
          docType: true,
          period: true,
          title: true,
          textContent: true,
          // MONEY-783: gcsPath lets us probe for the full-text sidecar (over-cap docs).
          gcsPath: true,
          // MONEY-779 perf: only PDF docs ever have a sidecar — mimeType gates
          // the probe so inline-text docs (Tickertape/Screener/video) skip the
          // GCS GET.
          mimeType: true,
          // MONEY-670: carry the real source URL into the chunk so the RAG tool
          // can surface a clickable citation instead of a "Filing chunk · SYM"
          // label.
          sourceUrl: true,
        },
        orderBy: { fetchedAt: "desc" },
        take: batchSize,
      });

  // MONEY-1328 — there is deliberately NO `if (documents.length === 0) return;`
  // here any more, and its absence is the fix.
  //
  // That early return sat ~260 lines above the `reportJobOutcome` at the tail,
  // so an IDLE NIGHT — the ordinary state of a drained queue — emitted no
  // metric at all. This is the SIBLING of the job MONEY-1255 fixed for exactly
  // this: `stock-document-extract` put its report below the same shape of
  // return and a `notify_no_data` monitor over a series that never emits read
  // healthy precisely when the job was doing nothing.
  //
  // The exit is REMOVED rather than given a second report site. Falling through
  // costs one `getEmbeddingModel()` (a pure env read), a loop over zero
  // documents and an empty coverage walk, and it reports `selected 0 /
  // written 0` from the one place that already knows how to describe this run —
  // which the clamped-difference monitor reads as healthy, and which is a
  // DIFFERENT thing from emitting nothing. Both `attempted > 0` guards below
  // are false at zero, so neither the throw nor the near-miss log can fire on
  // an empty batch.
  logger.info(
    documents.length === 0
      ? "No documents to embed"
      : `Found ${documents.length} documents to embed`,
  );

  // Tag every row we write with the model that produced it (env-gated).
  const embeddingModel = getEmbeddingModel();

  let embedded = 0;
  let failed = 0;
  let totalChunks = 0;
  // MONEY-1238 — the four ways a document can leave this loop having stored
  // NOTHING, counted separately because they mean different things. Before
  // this, `embedded++` sat outside the `storedCount > 0` branch, so a revoked
  // GOOGLE_GENAI_API_KEY — which makes `generateBatchEmbeddings` fail every
  // index for every document — printed "200 embedded, 0 failed, 0 total
  // chunks" and returned 200. Every number in that line was a lie except the
  // last, and the last one is the only one nobody alerts on.
  /** textContent too short to be worth embedding — normal, not a failure. */
  let skippedShort = 0;
  /** Chunker produced no chunks (empty/unstructured text). */
  let noChunks = 0;
  /** Chunks existed, and NOT ONE embedding came back usable. Never normal. */
  let zeroStored = 0;
  // MONEY-798 (P3c): distinct symbols touched this batch — used to log a
  // one-line corpus-coverage summary at completion (corpus-health visibility).
  const touchedSymbols = new Set<string>();

  for (const doc of documents) {
    if (shouldSkipDocument(doc.textContent)) {
      skippedShort++;
      continue;
    }

    try {
      // 0. Prefer the full-text sidecar (MONEY-783) over the capped preview.
      //    Over-cap extracted docs store only a capped textContent in the DB and
      //    the full text in a derived GCS sidecar; chunk the full text when it
      //    exists, otherwise fall back to the (possibly capped) textContent.
      // `shouldSkipDocument` above guarantees textContent is a non-empty string.
      //
      // MONEY-779 perf: the sidecar ONLY exists for over-cap PDF docs (the
      // extract worker writes it; inline-text docs — Tickertape/Screener/video —
      // never have one). Gate the GCS probe so we don't fire a guaranteed-404
      // GET for every inline-text doc on every run. Belt-and-suspenders: a PDF
      // whose capped preview is exactly at the cap is the only sidecar shape, so
      // also require textContent to have reached the cap before probing.
      let textToChunk: string = doc.textContent ?? "";
      const isPdf = doc.mimeType === "application/pdf";
      const maybeOverCap = (doc.textContent?.length ?? 0) >= MAX_TEXT_LENGTH;
      if (isPdf && maybeOverCap) {
        try {
          const sidecar = await downloadFromGCS(
            extractedSidecarPath(doc.gcsPath),
          );
          const full = sidecar.toString("utf-8");
          if (full.length > 0) textToChunk = full;
        } catch {
          // No sidecar (doc fit under the cap, or text-source doc) — use textContent.
        }
      }

      // 1. Chunk the text — dispatch on docType (MONEY-784 P3b): concall
      //    transcripts use speaker-turn chunking, annual reports use AR-heading
      //    chunking, everything else falls back to the section-aware chunker.
      const chunks = chunkByDocType(doc.docType, textToChunk, doc.symbol);
      if (chunks.length === 0) {
        noChunks++;
        continue;
      }

      // 2. Generate embeddings in batch
      const texts = chunks.map((c) => c.text);
      const { embeddings, failedIndices } = await embedBatch(texts);

      // 3. Delete old embeddings for this document if re-indexing
      if (forceReindex) {
        await deleteDocEmbeddings(doc.id);
      }

      // 4. Store each chunk's embedding.
      //
      // MONEY-1499: this is the writer that produces ~74% of the corpus, so
      // it is the one whose absence from the dual-write would leave the
      // biggest tail behind the backfill's cursor — and, after v1 is renamed,
      // would keep refilling an empty `document_embeddings` for ever without
      // erroring. `writeTargets` is read once per document, not per chunk.
      const targets = writeTargets(await getEmbeddingsMode());
      const v2Rows: EmbeddingUpsert[] = [];
      let storedCount = 0;
      for (let i = 0; i < chunks.length; i++) {
        if (failedIndices.includes(i)) continue;
        const emb = embeddings[i];
        if (!emb || emb.length === 0) continue;

        if (targets.includes("v2")) {
          v2Rows.push({
            userId: SYSTEM_USER_ID,
            docType: doc.docType,
            docId: doc.id,
            chunkId: chunks[i]!.chunkIndex,
            content: chunks[i]!.text,
            embedding: emb,
            embeddingModel,
            metadata: {
              symbol: doc.symbol,
              period: doc.period,
              title: doc.title,
              sourceDocId: doc.id,
              sourceUrl: doc.sourceUrl ?? undefined,
            },
          });
        }

        if (!targets.includes("v1")) {
          storedCount++;
          continue;
        }

        await prisma.documentEmbedding.upsert({
          where: {
            userId_docType_docId_chunkId: {
              userId: SYSTEM_USER_ID,
              docType: doc.docType,
              docId: doc.id,
              chunkId: chunks[i]!.chunkIndex,
            },
          },
          create: {
            userId: SYSTEM_USER_ID,
            docType: doc.docType,
            docId: doc.id,
            chunkId: chunks[i]!.chunkIndex,
            content: chunks[i]!.text,
            embedding: emb,
            embeddingModel,
            metadata: {
              symbol: doc.symbol,
              period: doc.period,
              title: doc.title,
              sourceDocId: doc.id,
              sourceUrl: doc.sourceUrl ?? undefined,
            },
          },
          update: {
            content: chunks[i]!.text,
            embedding: emb,
            embeddingModel,
            metadata: {
              symbol: doc.symbol,
              period: doc.period,
              title: doc.title,
              sourceDocId: doc.id,
              sourceUrl: doc.sourceUrl ?? undefined,
            },
          },
        });
        storedCount++;
      }

      if (v2Rows.length > 0) {
        const { refused } = await upsertEmbeddingsV2(
          (cmd) => prisma.$runCommandRaw(cmd as never),
          v2Rows,
        );
        if (refused.length > 0) {
          // NAMED, never a silent skip: a chunk whose vector will not quantize
          // is a chunk the v2 corpus does not have.
          logger.error(
            `stock-document-embed: ${refused.length} chunk(s) REFUSED by v2 for ` +
              `${doc.symbol} ${doc.id} — ${refused.map((r) => r.reason).join(",")}`,
          );
          if (!targets.includes("v1")) storedCount -= refused.length;
        }
      }

      // 5. Mark document as embedded
      if (storedCount > 0) {
        await prisma.stockDocument.update({
          where: { id: doc.id },
          data: {
            isEmbedded: true,
            embeddingCount: storedCount,
          },
        });

        // 5b. MONEY-804 (P3c): keep the managed Vertex corpus fresh. Atlas is the
        // primary store (written above); this is a best-effort ALSO-write, gated
        // strictly on vertexRagConfigured() so it's completely INERT when the flag
        // is off (no corpus resolve, no import call). Failures never affect the
        // embed result — the doc is already embedded into Atlas.
        if (vertexRagConfigured()) {
          const gcsUri = gcsUriForDocument(doc.gcsPath);
          if (gcsUri) {
            try {
              const ok = await importFiles(ragCorpus(), [gcsUri]);
              if (!ok) {
                logger.warn(
                  `Vertex re-import skipped/failed for ${doc.symbol} (${doc.id})`,
                );
              }
            } catch (vErr) {
              // importFiles never throws, but guard anyway — Vertex freshness is
              // strictly best-effort and must never fail an Atlas-embedded doc.
              logger.warn(
                `Vertex re-import error for ${doc.symbol} (${doc.id}): ${vErr instanceof Error ? vErr.message : vErr}`,
              );
            }
          }
        }

        embedded++;
        totalChunks += storedCount;
        if (doc.symbol) touchedSymbols.add(doc.symbol);
      } else {
        // Chunked, embedded-request issued, and not one vector survived. The
        // document is deliberately NOT marked `isEmbedded`, so it is picked up
        // again next run — but the run must SAY so, or the retry is the only
        // evidence and nobody is watching a queue that never drains.
        zeroStored++;
        logger.warn(
          `${doc.symbol} (${doc.docType}/${doc.period}): ${chunks.length} chunk(s) ` +
            `produced ZERO stored embeddings — the embedding backend refused every one`,
        );
      }

      // `embedded > 0` — MONEY-1236. This used to sit after an unconditional
      // `embedded++` so it could never see zero; it now lives where the
      // `zeroStored` path leaves `embedded` at 0, and `0 % 20 === 0`, so a run
      // where the backend refuses EVERY document logged a progress line for
      // every single one.
      if (embedded > 0 && embedded % 20 === 0) {
        logger.info(
          `Progress: ${embedded}/${documents.length} docs, ${totalChunks} chunks`,
        );
      }

      // Rate limit between documents. `documentDelayMs` defaults to
      // `DELAY_BETWEEN_BATCHES_MS`; a test passes 0 so a three-document fixture
      // is not three real seconds (the same reason `corporate-actions-sync`
      // exposes `delayBetweenSymbolsMs`).
      if (documentDelayMs > 0) {
        await new Promise((r) => setTimeout(r, documentDelayMs));
      }
    } catch (err) {
      failed++;
      logger.error(
        `Failed to embed ${doc.symbol} (${doc.docType}/${doc.period}): ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  logger.info(
    `Embedding complete: ${embedded} embedded, ${failed} failed, ` +
      `${zeroStored} chunked-but-stored-nothing, ${noChunks} produced no chunks, ` +
      `${skippedShort} too short, ${totalChunks} total chunks ` +
      `(of ${documents.length} selected)`,
  );

  // MONEY-798 (P3c): corpus-coverage summary — one line per symbol touched this
  // batch (embedded / total docs, % of the symbol's corpus embedded). Surfaces
  // RAG corpus health in the logs. Best-effort; never affects the embed result.
  for (const sym of touchedSymbols) {
    try {
      const cov = await getRagCoverage(sym);
      logger.info(
        `Coverage ${sym}: ${cov.embedded}/${cov.total} embedded (${cov.pct}%), ${cov.pending} pending`,
      );
    } catch {
      // best-effort: coverage logging never fails the batch.
    }
  }

  // MONEY-1238 — the ONE shape that must not return 200.
  //
  // `attempted` counts documents that got as far as a real embedding request:
  // long enough to chunk, and chunked to at least one chunk. A run where every
  // single one of those stored nothing is not a quiet night — it is a revoked
  // key, an exhausted quota or a wrong model id, and it is INVISIBLE from the
  // outside because no row changes and no exception escapes. Throwing hands the
  // route a 500, which Pub/Sub redelivers (bounded: max-delivery-attempts=5,
  // then the shared dead-letter topic raises it). Nothing was persisted, so
  // there is no partial progress a redelivery could damage.
  //
  // THE CONDITION IS `zeroStored === attempted`, NOT `embedded === 0` —
  // MONEY-1236.
  //
  // `embedded === 0` also matches a batch the loop is explicitly built to
  // absorb. Near the tail of the queue a batch is one or two documents; if two
  // are `skippedShort` and the remaining one THROWS on its GCS read, then
  // `attempted === 1`, `embedded === 0`, and the old test fired — 500, five
  // redeliveries, dead-letter and a founder notification, for one bad document.
  //
  // The two failure modes are already distinguished by the counters, and only
  // one of them is the backend refusing:
  //
  //   `failed`     — the document threw. Per-document, isolated by design.
  //   `zeroStored` — the document CHUNKED FINE and the embedding call stored
  //                  nothing. That is the revoked-key / exhausted-quota /
  //                  wrong-model-id shape, and it is the whole reason this
  //                  guard exists.
  //
  // Requiring EVERY attempted document to be `zeroStored` keeps the guard exact
  // and needs no arbitrary batch-size floor: one document that chunked and
  // stored nothing really is the backend refusing, while any mix that includes a
  // per-document throw is the ordinary isolated failure.
  const attempted = embedded + zeroStored + failed;
  // `selected` is ATTEMPTED documents — long enough to chunk and chunked to at
  // least one chunk. Documents skipped as too short were never write candidates,
  // so an all-short batch reports selected 0 and cannot alarm. `zeroStored`
  // counts as failed: the document chunked fine and the embedding call stored
  // nothing, which is the revoked-key shape.
  report({
    job: "stock-document-embed",
    selected: attempted,
    written: embedded,
    failed: zeroStored + failed,
    ...(attempted > 0 && embedded === 0
      ? {
          skippedReason: `${zeroStored} chunked-but-stored-nothing, ${failed} threw, model=${embeddingModel}`,
        }
      : {}),
  });
  if (attempted > 0 && zeroStored === attempted) {
    throw new Error(
      `stock-document-embed stored ZERO embeddings from ${attempted} attempted ` +
        `document(s), ALL of which chunked successfully and stored nothing ` +
        `(${failed} threw, ${documents.length} selected, model=${embeddingModel}). ` +
        `This is the revoked-key / exhausted-quota shape, not a quiet batch.`,
    );
  }
  if (attempted > 0 && embedded === 0 && zeroStored < attempted) {
    // The near-miss: nothing embedded, but at least one document failed for its
    // own reason. Loud, and ACKed — retrying a bad document cannot fix it.
    logger.error(
      `stock-document-embed embedded NOTHING from ${attempted} attempted ` +
        `document(s) (${zeroStored} stored-nothing, ${failed} threw). Not the ` +
        `backend-refusal shape, so it is not retried — check the failures above.`,
    );
  }
}

/** Delete existing embeddings for a specific stock document */
async function deleteDocEmbeddings(stockDocId: string): Promise<void> {
  await prisma.documentEmbedding.deleteMany({
    where: {
      userId: SYSTEM_USER_ID,
      docId: stockDocId,
    },
  });
  // MONEY-1499 — BOTH collections, unconditionally, not gated on the mode.
  // This runs before a re-embed, so a v2 row left behind is a STALE chunk of
  // a document that has been re-parsed: still retrievable, still scoring, and
  // no longer what the document says.
  await deleteEmbeddingsV2((cmd) => prisma.$runCommandRaw(cmd as never), {
    userId: oid(SYSTEM_USER_ID),
    docId: stockDocId,
  });
}
