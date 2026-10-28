/**
 * Documents service — pure logic (no Prisma / no I/O).
 *
 * Extracted from `documents.service.ts` so the security-critical decisions are
 * EXPORTED, unit-testable symbols the real service CALLS — not inline
 * expressions. Three concerns live here:
 *
 *  1. Pagination clamping (`clampDocumentPagination`). `getDocuments` forwards
 *     `skip`/`limit` straight into `prisma.userDocument.findMany`. The web action
 *     pre-validates with `DocumentFilterSchema`, but the service is a public
 *     `@usemoney/services` export — a future `apps/api` `/v1/documents` route
 *     (the api-sync rule guarantees one) would `parseInt(query("limit"))` →
 *     `NaN` / negative / absurd, which Prisma 5 THROWS on (`Invalid value …
 *     Expected Int`), turning a stray query string into a 500. Same bug class as
 *     `notifications-pagination.ts#clampPagination`; this is the regression guard.
 *
 *  2. The IDOR scope clause (`documentScopeWhere`). Every read/mutation of a
 *     UserDocument MUST be scoped by `{ id, userId }` so user A can never read or
 *     delete user B's document by id. Making the where-clause a single exported
 *     builder means the find AND the soft-delete mutation share ONE definition —
 *     a bare `{ id }` mutation (the classic IDOR) is then impossible by
 *     construction.
 *
 *  3. The user-facing readiness derivation (`deriveDocumentStatus`). A document
 *     can only be viewed/downloaded once `processingStatus === "READY"`; this is
 *     the single source of truth the download gate consults, total over any
 *     string (incl. null / unknown enum values).
 *
 * @see apps/web/__tests__/services/documents-logic-unit.test.ts
 * @see apps/web/__tests__/services/documents-service-e2e.test.ts
 */

// ── Pagination ──────────────────────────────────────────────────────

/** Default page size when `limit` is omitted/unusable. */
export const DEFAULT_DOCUMENT_LIMIT = 20;

/**
 * Hard ceiling on a single page. Bounds memory + payload regardless of what a
 * caller (or a hand-crafted `?limit=` query) asks for. Matches the
 * `DocumentFilterSchema` web cap so the service and the schema agree.
 */
export const MAX_DOCUMENT_LIMIT = 100;

export interface DocumentPaginationBounds {
  /** Safe `take`: integer in [1, MAX_DOCUMENT_LIMIT]. */
  take: number;
  /** Safe `skip`: non-negative integer. */
  skip: number;
}

/**
 * Coerce a possibly-untrusted numeric input to a finite integer, or `null` when
 * it can't be (NaN, ±Infinity, non-number). Floats are truncated toward zero.
 */
function toFiniteInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

/**
 * Clamp a (limit, skip) pair into safe Prisma `take`/`skip` bounds.
 *
 * - `limit`: NaN / Infinity / non-number / ≤ 0 → DEFAULT_DOCUMENT_LIMIT;
 *   anything above MAX_DOCUMENT_LIMIT is capped; floats truncated.
 * - `skip`: NaN / Infinity / non-number / negative → 0; floats truncated.
 *
 * Pure + total: never throws, always returns finite positive `take` and a
 * non-negative `skip`.
 */
export function clampDocumentPagination(
  limit: unknown = DEFAULT_DOCUMENT_LIMIT,
  skip: unknown = 0,
): DocumentPaginationBounds {
  const rawLimit = toFiniteInt(limit);
  const take =
    rawLimit === null || rawLimit <= 0
      ? DEFAULT_DOCUMENT_LIMIT
      : Math.min(rawLimit, MAX_DOCUMENT_LIMIT);

  const rawSkip = toFiniteInt(skip);
  const safeSkip = rawSkip === null || rawSkip < 0 ? 0 : rawSkip;

  return { take, skip: safeSkip };
}

// ── IDOR scope ──────────────────────────────────────────────────────

export interface DocumentScopeWhere {
  id: string;
  userId: string;
  isDeleted: false;
}

/**
 * The canonical ownership scope for a single UserDocument: BOTH the document id
 * AND the caller's userId (and `isDeleted: false`). Used by the read (`findFirst`)
 * AND the soft-delete (`updateMany`) so the mutation can never be a bare `{ id }`
 * — the bug that lets one user delete another's document.
 *
 * `userId` is required and non-empty-checked at the call site (an authenticated
 * action always supplies it); this builder just guarantees the shape is uniform.
 */
export function documentScopeWhere(
  id: string,
  userId: string,
): DocumentScopeWhere {
  return { id, userId, isDeleted: false };
}

// ── List filter ─────────────────────────────────────────────────────

export interface DocumentListFilters {
  category?: string;
  sourceType?: string;
  search?: string;
}

/**
 * Build the `where` clause for a document LIST query. Always pins
 * `{ userId, isDeleted: false }` (the per-user scope + soft-delete hide), then
 * layers optional `category` / `sourceType` equality and a case-insensitive
 * `title`/`fileName` search OR.
 *
 * A blank/whitespace-only `search` is ignored (no empty OR that would match
 * every row). Pure — returns a plain object, performs no I/O.
 */
export function buildDocumentListWhere(
  userId: string,
  filters: DocumentListFilters = {},
): Record<string, unknown> {
  const where: Record<string, unknown> = { userId, isDeleted: false };

  if (filters.category) where.category = filters.category;
  if (filters.sourceType) where.sourceType = filters.sourceType;

  const search = filters.search?.trim();
  if (search) {
    where.OR = [
      { title: { contains: search, mode: "insensitive" } },
      { fileName: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}

// ── Readiness derivation ────────────────────────────────────────────

export type DocumentReadiness = "ready" | "processing" | "failed" | "unknown";

export interface DerivedDocumentStatus {
  readiness: DocumentReadiness;
  /** True only when the document is fully processed and safe to view/download. */
  canDownload: boolean;
  /** True while text-extraction / generation is still in flight. */
  isProcessing: boolean;
  /** True when processing failed terminally. */
  isFailed: boolean;
}

/**
 * Derive a user-facing readiness verdict from the raw `processingStatus` enum.
 * The single source of truth for the "is this document downloadable?" gate.
 *
 * Total over any input: an unknown / null / garbage status is treated as NOT
 * downloadable (`unknown`, fail-closed) rather than silently downloadable.
 *
 * Enum (DocumentProcessingStatus): PENDING | PROCESSING | READY | FAILED.
 */
export function deriveDocumentStatus(
  processingStatus: string | null | undefined,
): DerivedDocumentStatus {
  switch (processingStatus) {
    case "READY":
      return {
        readiness: "ready",
        canDownload: true,
        isProcessing: false,
        isFailed: false,
      };
    case "PENDING":
    case "PROCESSING":
      return {
        readiness: "processing",
        canDownload: false,
        isProcessing: true,
        isFailed: false,
      };
    case "FAILED":
      return {
        readiness: "failed",
        canDownload: false,
        isProcessing: false,
        isFailed: true,
      };
    default:
      return {
        readiness: "unknown",
        canDownload: false,
        isProcessing: false,
        isFailed: false,
      };
  }
}
