/**
 * Content service — pure logic (no Prisma / no cache / no I/O).
 *
 * Extracted from `content.service.ts` so the security- and correctness-critical
 * decisions are EXPORTED, unit-testable symbols the real service CALLS — not
 * inline expressions or shadow re-implementations in the test file.
 *
 * Two concerns live here:
 *
 *  1. PAGE-based pagination (`clampPagePagination` + `computePages`). The list
 *     endpoints (blog / newsletters / docs) take `{ page, limit }` from query
 *     params and compute `skip = (page - 1) * limit`. Unclamped, a `?page=0`
 *     gives a NEGATIVE skip and a `?page=abc` / `?limit=abc` gives `NaN`, both of
 *     which Prisma 5 THROWS on (`Invalid value … Expected Int`) → a 500 from a
 *     stray query string. Worse, `Math.ceil(total / 0)` is `Infinity` and
 *     `Math.ceil(total / NaN)` is `NaN`, poisoning the `pages` count a consumer
 *     renders / loops over. This makes those inputs safe + deterministic.
 *
 *  2. The premium ENTITLEMENT gate (`decideContentAccess` + `redactPremiumPost`).
 *     Every post carries an `isPremium` flag. Premium content must FAIL CLOSED:
 *     its full `content` body must NOT be served to a FREE / unentitled / expired
 *     viewer. This is the single source of truth for that decision, mirroring the
 *     plan-tier model used by the live content stream gate
 *     (`route-logic.ts → hasFeatureAccess`, tiers FREE<PRO<PREMIUM<ULTIMATE).
 *     `redactPremiumPost` strips the body (keeping title/excerpt/metadata for the
 *     paywall preview) when access is denied.
 *
 * @see apps/web/__tests__/services/content-logic-unit.test.ts
 * @see apps/web/__tests__/services/content-service-e2e.test.ts
 */

import type { Post } from "@usemoney/types";

// ── Page-based pagination ───────────────────────────────────────────

/** Default page size when `limit` is omitted/unusable. */
export const DEFAULT_CONTENT_LIMIT = 10;

/**
 * Hard ceiling on a single content page. Bounds memory + payload regardless of
 * what a caller (or a hand-crafted `?limit=` query) asks for.
 */
export const MAX_CONTENT_LIMIT = 100;

export interface PageBounds {
  /** Safe page number: integer ≥ 1. */
  page: number;
  /** Safe `take`: integer in [1, MAX_CONTENT_LIMIT]. */
  limit: number;
  /** Safe `skip`: non-negative integer = (page - 1) * limit. */
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
 * Clamp a (page, limit) pair into safe Prisma bounds and derive `skip`.
 *
 * - `page`:  NaN / Infinity / non-number / < 1 → 1; floats truncated.
 * - `limit`: NaN / Infinity / non-number / ≤ 0 → DEFAULT_CONTENT_LIMIT;
 *   anything above MAX_CONTENT_LIMIT is capped; floats truncated.
 * - `skip = (page - 1) * limit` is therefore always a non-negative integer.
 *
 * Pure + total: never throws, always returns finite `page ≥ 1`, positive
 * `limit`, and `skip ≥ 0`.
 */
export function clampPagePagination(
  page: unknown,
  limit: unknown,
  defaultLimit: number = DEFAULT_CONTENT_LIMIT,
): PageBounds {
  const rawPage = toFiniteInt(page);
  const safePage = rawPage === null || rawPage < 1 ? 1 : rawPage;

  const safeDefault =
    Number.isInteger(defaultLimit) && defaultLimit > 0
      ? Math.min(defaultLimit, MAX_CONTENT_LIMIT)
      : DEFAULT_CONTENT_LIMIT;

  const rawLimit = toFiniteInt(limit);
  const safeLimit =
    rawLimit === null || rawLimit <= 0
      ? safeDefault
      : Math.min(rawLimit, MAX_CONTENT_LIMIT);

  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit,
  };
}

/**
 * Total page count for `total` items at `limit` per page. Guards against the
 * `Math.ceil(total / 0) === Infinity` and `Math.ceil(n / NaN) === NaN` foot-guns
 * that would poison a `pages` value a consumer renders or loops over.
 *
 * - non-positive / non-finite `total` → 0 pages.
 * - non-positive / non-finite `limit` → falls back to DEFAULT_CONTENT_LIMIT.
 *
 * Always returns a finite, non-negative integer.
 */
export function computePages(total: unknown, limit: unknown): number {
  const safeTotal = toFiniteInt(total);
  if (safeTotal === null || safeTotal <= 0) return 0;

  const safeLimit = toFiniteInt(limit);
  const denom =
    safeLimit === null || safeLimit <= 0 ? DEFAULT_CONTENT_LIMIT : safeLimit;

  return Math.ceil(safeTotal / denom);
}

// ── Premium entitlement gate ────────────────────────────────────────

/**
 * Subscription plan tiers, ordered. A viewer is "entitled" to premium content
 * when their tier is at or above PRO — the same boundary the live content-stream
 * gate enforces (`PremiumContentGate`: PRO/PREMIUM/ULTIMATE have access; FREE
 * does not).
 */
export const CONTENT_TIER_RANK: Record<string, number> = {
  FREE: 0,
  PRO: 1,
  PREMIUM: 2,
  ULTIMATE: 3,
};

/** Minimum rank that unlocks premium content. */
export const PREMIUM_ACCESS_MIN_RANK = 1;

/**
 * Who is asking for the content. `planId` is the viewer's current plan; an
 * `entitled === false` (or absent / expired) viewer is treated as FREE.
 *
 * - `planId`: e.g. "FREE" | "PRO" | "PREMIUM" | "ULTIMATE" (case-insensitive);
 *   an unknown / null / undefined value ranks as FREE (fail-closed).
 * - `entitled`: optional hard override. When the caller has already determined
 *   the subscription is expired / inactive, pass `false` to force a deny even if
 *   `planId` looks premium. When omitted, access derives from `planId` alone.
 */
export interface ContentViewer {
  planId?: string | null;
  entitled?: boolean;
}

export interface ContentAccessDecision {
  /** True ⇢ the full body may be served. */
  allowed: boolean;
  /** Why access was denied (for logging / UX); empty when allowed. */
  reason: "" | "premium_locked" | "entitlement_expired";
}

/** Normalize a plan id to its numeric rank; unknown / null → FREE (0). */
function tierRank(planId: string | null | undefined): number {
  if (typeof planId !== "string") return 0;
  return CONTENT_TIER_RANK[planId.trim().toUpperCase()] ?? 0;
}

/**
 * Decide whether `viewer` may receive the FULL body of a (possibly premium)
 * post. FAIL CLOSED:
 *
 *  - Non-premium content → always allowed (public).
 *  - Premium content + `entitled === false` → denied (`entitlement_expired`):
 *    an expired/inactive subscription must not still serve content, even at a
 *    premium `planId`.
 *  - Premium content + tier below PRO (incl. unknown/missing plan) → denied
 *    (`premium_locked`).
 *  - Premium content + tier ≥ PRO (and not explicitly de-entitled) → allowed.
 *
 * Pure + total: a `null`/`undefined` viewer is the anonymous (FREE) case.
 */
export function decideContentAccess(
  post: { isPremium: boolean },
  viewer?: ContentViewer | null,
): ContentAccessDecision {
  if (!post.isPremium) return { allowed: true, reason: "" };

  // Hard de-entitlement override (expired / inactive subscription).
  if (viewer?.entitled === false) {
    return { allowed: false, reason: "entitlement_expired" };
  }

  if (tierRank(viewer?.planId) >= PREMIUM_ACCESS_MIN_RANK) {
    return { allowed: true, reason: "" };
  }

  return { allowed: false, reason: "premium_locked" };
}

/**
 * Apply `decideContentAccess` to a full Post, returning the post a `viewer` is
 * actually allowed to see. When access is denied, the `content` body is replaced
 * with an empty string (the paywall preview keeps `title` / `excerpt` /
 * `featureImage` / metadata), so an unentitled viewer can never receive the
 * premium body — even if the caller forgets to gate it downstream.
 *
 * When access is allowed (or the post is non-premium), the post is returned
 * unchanged (same reference) — behavior-preserving for authorized access.
 */
export function redactPremiumPost(
  post: Post,
  viewer?: ContentViewer | null,
): Post {
  const decision = decideContentAccess(post, viewer);
  if (decision.allowed) return post;
  return { ...post, content: "" };
}
