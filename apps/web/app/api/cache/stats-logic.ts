/**
 * Pure logic for the cache-stats endpoint (`app/api/cache/stats/route.ts`).
 *
 * Extracted so the hit-rate maths, the dual-layer aggregation, and the Redis
 * `INFO` parsing can be unit tested directly. The route imports & calls these —
 * production runs the same code the tests assert.
 */

export interface CacheLayerStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
}

export interface CacheStats {
  memory: CacheLayerStats;
  redis: CacheLayerStats;
}

export interface OverallCacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  hitRate: string;
}

export interface RedisConnectedInfo {
  connected: true;
  totalConnectionsReceived: string;
  totalCommandsProcessed: string;
  keyCount: number;
}

export interface RedisDisconnectedInfo {
  connected: false;
  message: string;
}

/**
 * Hit rate as a 2-dp percentage string. Division-by-zero safe: with zero
 * traffic the rate is "0.00" (never NaN).
 */
export function calculateHitRate(hits: number, misses: number): string {
  if (hits + misses === 0) return "0.00";
  return ((hits / (hits + misses)) * 100).toFixed(2);
}

/** Aggregate the memory + redis layers into the combined "overall" stats. */
export function calculateOverallStats(stats: CacheStats): OverallCacheStats {
  const totalHits = stats.memory.hits + stats.redis.hits;
  const totalMisses = stats.memory.misses + stats.redis.misses;
  return {
    hits: totalHits,
    misses: totalMisses,
    sets: stats.memory.sets + stats.redis.sets,
    deletes: stats.memory.deletes + stats.redis.deletes,
    errors: stats.memory.errors + stats.redis.errors,
    hitRate: `${calculateHitRate(totalHits, totalMisses)}%`,
  };
}

/**
 * Parse a Redis `INFO` reply into key→value pairs. Skips comment (`#`) and
 * blank lines and any line without a `key:value` shape.
 */
export function parseRedisInfo(info: string): Record<string, string> {
  const statsObj: Record<string, string> = {};
  const lines = info.split("\r\n");
  for (const line of lines) {
    if (line && !line.startsWith("#")) {
      const [key, value] = line.split(":");
      if (key && value) {
        statsObj[key] = value;
      }
    }
  }
  return statsObj;
}

/** Shape the "Redis connected" branch of the stats response. */
export function buildRedisConnectedInfo(
  statsObj: Record<string, string>,
  keyCount: number
): RedisConnectedInfo {
  return {
    connected: true,
    totalConnectionsReceived: statsObj.total_connections_received || "N/A",
    totalCommandsProcessed: statsObj.total_commands_processed || "N/A",
    keyCount,
  };
}

/** Shape the "Redis not available" branch of the stats response. */
export function buildRedisDisconnectedInfo(): RedisDisconnectedInfo {
  return {
    connected: false,
    message: "Redis not available - using in-memory cache only",
  };
}
