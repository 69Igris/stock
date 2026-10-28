/**
 * MONEY-393 §15 - /api/research/preview-plan/[jobId]/status tests.
 *
 * Source-text guards for the polling endpoint added in MONEY-240:
 *   - Auth-gated via Clerk auth()
 *   - jobId validation (length cap + character allow-list)
 *   - 202 with `{ pending: true }` while the worker is still running
 *   - 200 with the full PreviewPlanResponse once cached
 *   - cache-control: no-store on both branches (must always re-poll)
 *   - Cache namespace + TTL match the worker's write key
 *   - Job key is USER-NAMESPACED (MONEY-595 A01): the endpoint reads only the
 *     caller's own `…:job:{userId}:{jobId}` namespace, so a leaked/guessed
 *     jobId can never surface another user's rewritten brief.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "app",
    "api",
    "research",
    "preview-plan",
    "[jobId]",
    "status",
    "route.ts"
  ),
  "utf8"
);

describe("MONEY-393 §15 - /api/research/preview-plan/[jobId]/status", () => {
  it("[exports] GET handler is declared", () => {
    assert.match(SRC, /export\s+async\s+function\s+GET\s*\(/);
  });

  it("[auth] reads userId from Clerk auth() and returns 401 when unauthenticated", () => {
    assert.match(SRC, /await\s+auth\(\)/);
    assert.match(SRC, /Unauthorized/);
    assert.match(SRC, /status:\s*401/);
  });

  it("[validation] caps jobId length at ≤64 chars (no unbounded inputs)", () => {
    assert.match(SRC, /jobId\.length\s*>\s*64/);
  });

  it("[validation] jobId must match the allow-list regex (alphanumeric + hyphen, case-insensitive)", () => {
    assert.match(SRC, /\/\^\[a-z0-9-\]\+\$\/i\.test\(jobId\)/);
    assert.match(SRC, /Invalid jobId/);
    assert.match(SRC, /status:\s*400/);
  });

  it("[cache] reads from `research:preview-plan:job:{userId}:{jobId}` (user-namespaced, matches worker write key)", () => {
    assert.match(SRC, /research:preview-plan/);
    // MONEY-595 (A01): key MUST fold in the authenticated caller's userId
    // ahead of the jobId so a leaked jobId can't read another user's result.
    assert.match(SRC, /\$\{CACHE_NS\}:job:\$\{userId\}:\$\{jobId\}/);
  });

  it("[idor] job key is derived from the request's own authenticated userId", () => {
    // The userId interpolated into the cache key is the one read from
    // Clerk auth() on THIS request — never a client-supplied value.
    assert.match(SRC, /const\s*\{\s*userId\s*\}\s*=\s*await\s+auth\(\)/);
  });

  it("[cache] TTL = 120 seconds (≤ worker's max processing time)", () => {
    assert.match(SRC, /CACHE_TTL_SECONDS\s*=\s*120/);
  });

  it("[cache] dual-layer enabled (memory + Redis)", () => {
    // Pattern: `{ ttl, enableMemory: true, enableRedis: true }` - the
    // status endpoint hits this hundreds of times during a typical
    // poll, so the memory layer is critical for cost.
    assert.match(src(), /enableMemory:\s*true/);
    assert.match(src(), /enableRedis:\s*true/);
  });

  it("[pending] returns 202 with `{ pending: true, jobId }` when cache miss", () => {
    assert.match(src(), /status:\s*202/);
    assert.match(src(), /pending:\s*true/);
  });

  it("[ready] returns 200 with the cached payload when found", () => {
    // Default NextResponse.json status is 200. The cache-control
    // header is no-store so a stale CDN doesn't replay an old
    // pending response after the job completes.
    assert.match(src(), /NextResponse\.json\(cached/);
  });

  it("[caching] cache-control: no-store on every response (must always re-poll)", () => {
    // 202 + 200 must both set no-store so the client polls every
    // tick, not a CDN-cached "pending" or "ready" response.
    const occurrences =
      src().match(/cache-control["']\s*:\s*["']no-store/g) ?? [];
    assert.ok(
      occurrences.length >= 2,
      `expected ≥2 no-store cache-control headers, got ${occurrences.length}`
    );
  });

  it("[errors] cache.get failures are swallowed with a null fallback (treats as pending)", () => {
    // .catch(() => null) - protects against a transient Redis hiccup
    // mid-poll. The client just sees another `pending:true`.
    assert.match(src(), /\.catch\(\(\)\s*=>\s*null\)/);
  });
});

function src(): string {
  return SRC;
}
