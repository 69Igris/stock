/**
 * Reads the `EMBEDDINGS_V2` PlatformConfig flag. MONEY-1499 (B8).
 *
 * The I/O shell for `resolveEmbeddingsMode` in `embeddings-int8-logic.ts`.
 *
 * WHY THIS IS IN `core` AND NOT IN `packages/services` next to `getConfig`:
 * `packages/services` already depends on `@usemoney/research`, and the research
 * package is one of the three callers — so a read helper there would be a
 * cycle. `core` is the only package all three callers (research, apps/web,
 * workers) already depend on. The duplicated part is a five-line
 * `findUnique`; the decision it feeds is single-sourced in the pure module.
 *
 * FAIL-SAFE AND NEVER CACHE A FAILURE. A Mongo blip returns `off`, which is
 * today's behaviour, and is NOT written to the cache — otherwise one bad read
 * pins every reader to v1 for the whole TTL after the cluster has recovered.
 * Same shape as `apps/web/lib/market/quotes-target.ts`.
 */

import prisma from "@usemoney/database";
import {
  EMBEDDINGS_V2_FLAG,
  resolveEmbeddingsMode,
  type EmbeddingsMode,
} from "./embeddings-int8-logic";

const CACHE_TTL_MS = 30_000;

let cached: { mode: EmbeddingsMode; at: number } | null = null;

/**
 * Resolved PER CALL behind a 30s TTL, never a module-scope const: these
 * processes are long-lived (a warm Cloud Run container, a Vercel lambda), and
 * a module-level read freezes the flag at import — turning a deliberate
 * cut-over into no cut-over at all.
 */
export async function getEmbeddingsMode(
  nowMs: number = Date.now(),
): Promise<EmbeddingsMode> {
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.mode;
  try {
    const row = await prisma.platformConfig.findUnique({
      where: { key: EMBEDDINGS_V2_FLAG },
    });
    const mode = resolveEmbeddingsMode(row?.value);
    cached = { mode, at: nowMs };
    return mode;
  } catch {
    // Deliberately NOT cached — see the header.
    return "off";
  }
}

/** Test seam: drops the TTL cache. */
export function resetEmbeddingsModeCache(): void {
  cached = null;
}
