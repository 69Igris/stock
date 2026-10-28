import { NextResponse } from "next/server";
import { getRedisClient, getCacheStats, resetCacheStats } from "@usemoney/core";
import { cacheLogger as logger } from "@usemoney/logger";
import { checkAdminAuth } from "@usemoney/auth";
import {
  calculateHitRate,
  calculateOverallStats,
  parseRedisInfo,
  buildRedisConnectedInfo,
  buildRedisDisconnectedInfo,
  type RedisConnectedInfo,
  type RedisDisconnectedInfo,
} from "../stats-logic";

/**
 * GET /api/cache/stats
 * Get cache statistics including hit rates, memory usage, and Redis connection status
 *
 * RESTRICTED: Only accessible by admin users (Clerk role metadata or ADMIN_EMAILS env var)
 */
export async function GET() {
  try {
    // Check admin authentication
    const { isAdmin, userEmail } = await checkAdminAuth();

    if (!isAdmin) {
      return NextResponse.json(
        {
          error: "Unauthorized: Admin access required",
          message: "Cache statistics are restricted to admin users only",
        },
        { status: 403 }
      );
    }

    // Get cache statistics from dual-layer cache
    const cacheStats = getCacheStats();

    // Get Redis connection status
    const redisClient = getRedisClient();
    const redisConnected = redisClient?.status === "ready";

    let redisInfo:
      | RedisConnectedInfo
      | RedisDisconnectedInfo
      | { connected: boolean; error: string }
      | null = null;
    if (redisClient && redisConnected) {
      try {
        // Get Redis info
        const info = await redisClient.info("stats");
        const statsObj = parseRedisInfo(info);

        // Get key count
        const keyCount = await redisClient.dbsize();

        redisInfo = buildRedisConnectedInfo(statsObj, keyCount);
      } catch (error) {
        redisInfo = {
          connected: true,
          error: "Failed to fetch Redis stats",
        };
      }
    } else {
      redisInfo = buildRedisDisconnectedInfo();
    }

    // Calculate hit rates
    const memoryHitRate = calculateHitRate(
      cacheStats.memory.hits,
      cacheStats.memory.misses
    );
    const redisHitRate = calculateHitRate(
      cacheStats.redis.hits,
      cacheStats.redis.misses
    );

    return NextResponse.json({
      success: true,
      data: {
        cache: {
          memory: {
            ...cacheStats.memory,
            hitRate: `${memoryHitRate}%`,
          },
          redis: {
            ...cacheStats.redis,
            hitRate: `${redisHitRate}%`,
          },
          overall: calculateOverallStats(cacheStats),
        },
        redis: redisInfo,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error({ error }, "Error fetching cache stats");
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch cache stats",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/cache/stats
 * Reset cache statistics counters
 *
 * RESTRICTED: Only accessible by admin users (Clerk role metadata or ADMIN_EMAILS env var)
 */
export async function DELETE() {
  try {
    // Check admin authentication
    const { isAdmin, userEmail } = await checkAdminAuth();

    if (!isAdmin) {
      return NextResponse.json(
        {
          error: "Unauthorized: Admin access required",
          message: "Cache statistics reset is restricted to admin users only",
        },
        { status: 403 }
      );
    }

    // Reset cache statistics
    resetCacheStats();

    return NextResponse.json({
      success: true,
      message: "Cache statistics reset successfully",
    });
  } catch (error) {
    logger.error({ error }, "Error resetting cache stats");
    return NextResponse.json(
      {
        success: false,
        error: "Failed to reset cache stats",
      },
      { status: 500 }
    );
  }
}
