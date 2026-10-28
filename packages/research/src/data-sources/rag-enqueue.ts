/**
 * RAG enqueue + corpus-coverage helper (MONEY-798 / P3c).
 *
 * The unifying entry-point for getting a discovered document INTO the RAG
 * corpus. A research run that surfaces a fresh filing (or any caller that has a
 * doc URL / extracted text) calls `enqueueDocumentForRag(...)`; this upserts a
 * `StockDocument` keyed on the existing unique `[symbol, exchange, docType,
 * period]`, and the already-shipped scheduled chain drains it:
 *
 *   PENDING (sourceUrl/PDF)  →  stock-document-extract  →  READY (textContent)
 *   READY (textContent)      →  stock-document-embed     →  isEmbedded:true
 *
 * NO publish is required — the daily `stock-document-extract-daily` scheduler
 * runs extract, which ALWAYS chains a `stock-document-embed` pass (embed no-ops
 * when nothing is pending), so PENDING rows get extracted and READY + unembedded
 * rows get embedded on the daily cadence. The
 * helper therefore lives in `packages/research` (prisma-only, no pubsub client)
 * so the research tools — which run inside the worker — can call it without
 * importing worker code.
 *
 * INVARIANTS:
 *   - Best-effort: never throws. A enqueue failure must never break a research
 *     run or a discovery tool.
 *   - Idempotent: the `[symbol, exchange, docType, period]` unique key dedupes,
 *     so the same filing discovered on every run upserts the SAME row.
 *   - DATABASE_URL-gated: no-ops when the DB isn't configured (e.g. a pure
 *     unit-test environment) so importing the module is side-effect-free.
 *   - SEBI-safe: only persists pointers to PRIMARY official sources
 *     (the caller passes the exchange attachment URL); no advice, no synthesis.
 *
 * @see workers/src/processors/stock-document-extract.ts (PENDING → READY)
 * @see workers/src/processors/stock-document-embed.ts (READY → embedded)
 */

import prisma from "@usemoney/database";
import type { StockDocType } from "./stock-document-paths";
import { canonicalSymbol } from "./source-cache";

const logger = {
  info: (...args: unknown[]) => console.log("[rag-enqueue]", ...args),
  warn: (...args: unknown[]) => console.warn("[rag-enqueue]", ...args),
};

/** Default period bucket for discovered docs that don't carry one. */
const DEFAULT_PERIOD = "latest";

export interface EnqueueDocumentArgs {
  /** Stock symbol (any exchange suffix is stripped to the canonical form). */
  symbol: string;
  /** Exchange the doc belongs to (default "NSE"). */
  exchange?: string;
  /** Document category — drives the chunker + retrieval. */
  docType: StockDocType;
  /** Primary official source URL (NSE/BSE attachment). PENDING docs need this. */
  sourceUrl?: string;
  /** Inline extracted text. When given the row is stored READY (embed picks up). */
  textContent?: string;
  /** Period bucket for the unique key (e.g. "Q3-2024", "FY2024-25"). */
  period?: string;
  /** MIME type of the source (default "application/pdf"). */
  mimeType?: string;
}

// ── PURE helpers (unit-tested directly; no Prisma / no env) ──────────────

/**
 * Build the deterministic identity for a discovered doc. Idempotency hinges on
 * this: the same filing always resolves to the SAME `[symbol, exchange, docType,
 * period]` tuple so the upsert dedupes across research runs. Symbol is
 * canonicalised (exchange/series suffix stripped, upper-cased) and the period
 * falls back to a stable bucket so a doc without an explicit period still has a
 * single stable row instead of churning new ones.
 */
export function buildEnqueueKey(args: {
  symbol: string;
  exchange?: string;
  docType: StockDocType;
  period?: string;
}): {
  symbol: string;
  exchange: string;
  docType: StockDocType;
  period: string;
} {
  return {
    symbol: canonicalSymbol(args.symbol),
    exchange: (args.exchange || "NSE").toUpperCase(),
    docType: args.docType,
    period: (args.period && args.period.trim()) || DEFAULT_PERIOD,
  };
}

/**
 * Decide the initial processing status for an enqueued doc.
 *   - inline `textContent` → READY (the embed worker chunks + embeds it),
 *   - else                 → PENDING (the extract worker fetches/OCRs the PDF).
 */
export function initialProcessingStatus(
  textContent?: string,
): "READY" | "PENDING" {
  return textContent && textContent.trim().length > 0 ? "READY" : "PENDING";
}

/**
 * Sanitise a value (symbol / docType / period) for use as a GCS path SEGMENT.
 * `/`, `\` and `..` must never reach the path — otherwise a hostile/typo'd
 * period like `../../x` would let the placeholder `gcsPath` escape the
 * `stocks/{SYMBOL}/…` prefix. Allow-lists path-safe chars and collapses any
 * remaining dot-only segment to a stable token.
 */
export function sanitizePathSegment(value: string): string {
  const clean = String(value || "")
    .replace(/[^A-Za-z0-9._&-]/g, "-") // drop `/`, `\`, whitespace, etc.
    .replace(/\.{2,}/g, "."); // collapse `..` (and longer) → single dot
  // A segment with no alphanumerics (e.g. "." or "-") is meaningless + unsafe.
  return /[A-Za-z0-9]/.test(clean) ? clean : "unknown";
}

/** True when a DB is configured. Enqueue is a no-op otherwise (best-effort). */
export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL;
}

// ── Coverage % (PURE) ────────────────────────────────────────────────────

export interface RagCoverage {
  total: number;
  embedded: number;
  pending: number;
  /** Embedded / total as a 0-100 integer percentage (0 when total is 0). */
  pct: number;
}

/**
 * Pure coverage maths over already-counted buckets. Kept separate from the
 * Prisma call so it's trivially unit-testable and reusable by the worker log.
 */
export function computeCoverage(counts: {
  total: number;
  embedded: number;
  pending: number;
}): RagCoverage {
  const total = Math.max(0, Math.trunc(counts.total) || 0);
  const embedded = Math.max(0, Math.trunc(counts.embedded) || 0);
  const pending = Math.max(0, Math.trunc(counts.pending) || 0);
  const pct = total > 0 ? Math.round((embedded / total) * 100) : 0;
  return { total, embedded, pending, pct };
}

// ── Side-effecting helpers (Prisma) ──────────────────────────────────────

/**
 * Minimal structural shape of the prisma surface the side-effecting helpers
 * touch. Lets tests inject a fake client (no real DB) while production passes
 * the real `prisma` default — the live call sites are unchanged. Method args
 * are `any` so the real (more-strongly-typed) prisma client stays assignable.
 */
export interface EnqueuePrismaClient {
  instrumentMapping: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst: (args: any) => Promise<{ id: string } | null>;
  };
  stockDocument: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: (args: any) => Promise<{
      id: string;
      isEmbedded: boolean;
      processingStatus: string;
    } | null>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: (args: any) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args: any) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    count: (args: any) => Promise<number>;
  };
}

/**
 * Idempotent best-effort enqueue of a document for RAG ingestion.
 *
 * Upserts a `StockDocument` on `[symbol, exchange, docType, period]`. With
 * `textContent` the row is READY (embed chain); otherwise PENDING with the
 * `sourceUrl` (extract → embed chain). Never throws and never publishes — the
 * scheduled extract/embed jobs drain the row.
 */
export async function enqueueDocumentForRag(
  args: EnqueueDocumentArgs,
  db: EnqueuePrismaClient = prisma,
): Promise<void> {
  try {
    if (!isDatabaseConfigured()) return;

    const key = buildEnqueueKey(args);
    if (!key.symbol) return; // nothing to key on

    // The StockDocument.instrumentId relation is required on create — resolve it
    // from the instrument master. If the symbol isn't a known instrument we
    // can't create a new row (skip); an EXISTING row is still re-touched below.
    const instrument = await db.instrumentMapping.findFirst({
      where: { symbol: key.symbol, exchange: key.exchange, isActive: true },
      select: { id: true },
    });

    const status = initialProcessingStatus(args.textContent);
    const mimeType =
      args.mimeType || (args.textContent ? "text/plain" : "application/pdf");
    // gcsPath is required (non-null). Discovered docs have no GCS object yet —
    // the extract worker downloads from `sourceUrl` and writes GCS. Use a
    // deterministic placeholder so the column is satisfied without a schema
    // change; the sync/extract path overwrites it when the bytes land.
    // key.symbol is already canonical (allow-listed), but the period is
    // caller-supplied — sanitise every segment so the placeholder path can never
    // escape the stocks/{SYMBOL} prefix.
    const gcsPath = `stocks/${sanitizePathSegment(key.symbol)}/${sanitizePathSegment(
      key.docType,
    )}/${sanitizePathSegment(key.period)}`;

    const existing = await db.stockDocument.findUnique({
      where: {
        symbol_exchange_docType_period: {
          symbol: key.symbol,
          exchange: key.exchange,
          docType: key.docType,
          period: key.period,
        },
      },
      select: { id: true, isEmbedded: true, processingStatus: true },
    });

    if (existing) {
      // Idempotent: a known filing re-discovered on a later run. Only fill gaps
      // — never demote a doc that's already READY/embedded back to PENDING, and
      // never re-touch a healthy row (avoids churning the extract/embed chain).
      if (args.textContent && existing.processingStatus !== "READY") {
        await db.stockDocument.update({
          where: { id: existing.id },
          data: {
            textContent: args.textContent.slice(0, 100_000),
            processingStatus: "READY",
            isEmbedded: false,
            ...(args.sourceUrl ? { sourceUrl: args.sourceUrl } : {}),
            fetchedAt: new Date(),
          },
        });
      }
      return;
    }

    if (!instrument) {
      // No instrument mapping → can't satisfy the required relation. Skip
      // quietly; the scheduled sync will create the row once the master has it.
      logger.warn(
        `No instrument mapping for ${key.symbol}:${key.exchange} — skipping RAG enqueue (${key.docType})`,
      );
      return;
    }

    await db.stockDocument.create({
      data: {
        instrumentId: instrument.id,
        symbol: key.symbol,
        exchange: key.exchange,
        docType: key.docType,
        period: key.period,
        title: `${key.symbol} ${key.docType} ${key.period}`,
        sourceUrl: args.sourceUrl,
        sourceType: "NSE",
        gcsPath,
        mimeType,
        processingStatus: status,
        ...(args.textContent
          ? { textContent: args.textContent.slice(0, 100_000) }
          : {}),
        isEmbedded: false,
        fetchedAt: new Date(),
      },
    });

    logger.info(
      `Enqueued ${key.docType} for ${key.symbol}:${key.exchange} (${status})`,
    );
  } catch (err) {
    // Best-effort: a enqueue failure must never break the caller.
    logger.warn(
      `enqueueDocumentForRag failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Corpus-coverage snapshot for a symbol: how much of its `StockDocument` set is
 * embedded into the RAG index vs still pending extraction/embedding. Best-effort
 * — returns a zeroed snapshot on any error or when the DB isn't configured.
 */
export async function getRagCoverage(
  symbol: string,
  exchange?: string,
  db: EnqueuePrismaClient = prisma,
): Promise<RagCoverage> {
  try {
    if (!isDatabaseConfigured())
      return computeCoverage({ total: 0, embedded: 0, pending: 0 });

    const sym = canonicalSymbol(symbol);
    if (!sym) return computeCoverage({ total: 0, embedded: 0, pending: 0 });

    const where = {
      symbol: sym,
      ...(exchange ? { exchange: exchange.toUpperCase() } : {}),
    };

    const [total, embedded, pending] = await Promise.all([
      db.stockDocument.count({ where }),
      db.stockDocument.count({ where: { ...where, isEmbedded: true } }),
      db.stockDocument.count({
        where: {
          ...where,
          processingStatus: { in: ["PENDING", "PROCESSING"] },
        },
      }),
    ]);

    return computeCoverage({ total, embedded, pending });
  } catch {
    return computeCoverage({ total: 0, embedded: 0, pending: 0 });
  }
}
