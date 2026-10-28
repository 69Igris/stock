/**
 * Documents Routes
 *
 * User-document list + detail reads, ownership-scoped by userId (soft-deleted
 * rows are hidden by the service). Thin wrappers over documents.service.
 *
 * SERVICE GAP (deferred): the signed DOWNLOAD url is generated in the apps/web
 * action layer (apps/web/lib/actions/documents.ts → generateSignedUrl(
 * storagePath)) via @usemoney/storage — a GCS dependency apps/api does NOT
 * carry, and documents.service deliberately keeps GCS/signed-URL out of the
 * service ("Upload, signed URLs, GCS operations … stay in the action layer").
 * So GET /v1/documents/:id/download is NOT wired here; it needs a
 * `getDocumentDownloadUrl(userId, id)` service extraction (getDocument
 * ownership check → getSignedUrl(storagePath)). The detail read below returns
 * the storagePath/originalUrl REFERENCE — the client resolves bytes itself,
 * the API never proxies them.
 */

import { Hono } from "hono";
import type { AppContext } from "../../app";
import { success, error, ErrorCodes, paginate } from "../../lib/response";
import { getDocuments, getDocument, deleteDocument } from "@usemoney/services";
import { parsePagination } from "./pagination";
import { isEntitled } from "../../lib/premium-gate";

const documentsRoutes = new Hono<AppContext>();

/**
 * GET /v1/documents
 * Paginated, userId-scoped document list. Optional ?category / ?sourceType /
 * ?search filters (undefined values are ignored by the service).
 */
documentsRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "documentVault"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  const { page, limit, skip } = parsePagination({
    page: c.req.query("page"),
    limit: c.req.query("limit"),
  });

  const result = await getDocuments(userId, {
    category: c.req.query("category"),
    sourceType: c.req.query("sourceType"),
    search: c.req.query("search"),
    skip,
    limit,
  });
  if (!result.success) {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
  }

  return c.json(
    paginate(result.data.documents, result.data.total, page, limit),
  );
});

/**
 * GET /v1/documents/:id
 * Single document detail for a document the caller owns (getDocument scopes by
 * userId) — a guessed id resolves as 404. Returns the storagePath/originalUrl
 * reference, never bytes (see the download service gap above).
 */
documentsRoutes.get("/:id", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "documentVault"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  const id = c.req.param("id");

  const result = await getDocument(userId, id);
  if (!result.success) {
    // A DB error (code "INTERNAL") is a 500; a missing/foreign document → 404.
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success(result.data));
});

/**
 * DELETE /v1/documents/:id
 * Soft-delete a document the caller owns. Mirrors deleteDocumentAction
 * (apps/web lib/actions/documents.ts:414)'s core delete — deleteDocument(
 * userId, id) scopes the MUTATION itself by { id, userId, not-deleted }
 * (updateMany count guard), so a foreign/missing/already-deleted id → 404 with
 * no existence oracle. GCS-blob + embedding cleanup stays in the web action
 * layer (apps/api carries no GCS dependency); the soft-deleted row is hidden
 * from every list/detail read either way.
 */
documentsRoutes.delete("/:id", async (c) => {
  const userId = c.get("userId");
  // MONEY-1142 — tier gate. apps/web enforced this; apps/api did not, so a
  // FREE user with a valid Clerk JWT could curl this endpoint and receive the
  // premium payload with no client involved at all.
  if (!(await isEntitled(userId, "documentVault"))) {
    return c.json(
      error(ErrorCodes.SUBSCRIPTION_REQUIRED, "Upgrade required"),
      403,
    );
  }

  const id = c.req.param("id");

  const result = await deleteDocument(userId, id);
  if (!result.success) {
    if (result.code === "INTERNAL") {
      return c.json(error(ErrorCodes.INTERNAL_ERROR, result.error), 500);
    }
    return c.json(error(ErrorCodes.NOT_FOUND, result.error), 404);
  }

  return c.json(success({ message: "Document deleted" }));
});

export default documentsRoutes;
