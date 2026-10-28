import { NextRequest, NextResponse } from "next/server";
import {
  getRedisClient,
  cacheClient,
  clearAllUserCache,
  clearUserCache,
  clearCachePattern,
} from "@usemoney/core";
import { cacheLogger as logger } from "@usemoney/logger";
import { checkAdminAuth } from "@usemoney/auth";
import {
  type ClearResult,
  buildAllClearResult,
  buildUserModulesClearResult,
  buildUserAllClearResult,
  buildPatternClearResult,
  buildMemoryClearResult,
} from "../clear-logic";

/**
 * POST /api/cache/clear
 * Clear Redis cache based on different strategies
 *
 * Request body options:
 * 1. Clear all cache: { action: "all" }
 * 2. Clear user cache: { action: "user", userId: "user123" }
 * 3. Clear specific modules: { action: "user", userId: "user123", modules: ["dashboard", "positions"] }
 * 4. Clear by pattern: { action: "pattern", pattern: "dashboard:*" }
 * 5. Clear memory only: { action: "memory" }
 *
 * RESTRICTED: Only accessible by admin users (Clerk role metadata or ADMIN_EMAILS env var)
 */
export async function POST(request: NextRequest) {
  try {
    // Check admin authentication
    const { isAdmin, userId, userEmail } = await checkAdminAuth();

    if (!isAdmin) {
      return NextResponse.json(
        {
          error: "Unauthorized: Admin access required",
          message: "Cache clearing is restricted to admin users only",
        },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { action, userId: targetUserId, modules, pattern } = body;

    if (!action) {
      return NextResponse.json(
        { error: "Missing 'action' parameter" },
        { status: 400 }
      );
    }

    let result: ClearResult = {
      success: true,
      message: "",
    };

    switch (action) {
      case "all": {
        // NUCLEAR OPTION: Clear all Redis cache
        const redis = getRedisClient();
        if (!redis) {
          return NextResponse.json(
            { error: "Redis not available" },
            { status: 503 }
          );
        }

        logger.warn(
          { userId, userEmail, action: "clear_all_cache" },
          "Admin clearing ALL Redis cache"
        );

        // Get count before flushing
        const keyCount = await redis.dbsize();

        // Flush entire Redis database
        await redis.flushdb();

        // Clear memory cache as well
        await cacheClient.clearMemory();

        result = buildAllClearResult(keyCount);
        break;
      }

      case "user": {
        // Clear cache for specific user
        if (!targetUserId) {
          return NextResponse.json(
            { error: "Missing 'userId' parameter" },
            { status: 400 }
          );
        }

        logger.info({ userId, targetUserId, modules }, "Clearing user cache");

        if (modules && Array.isArray(modules)) {
          // Clear specific modules
          await clearUserCache(targetUserId, modules);
          result = buildUserModulesClearResult(targetUserId, modules);
        } else {
          // Clear all user cache
          await clearAllUserCache(targetUserId);
          result = buildUserAllClearResult(targetUserId);
        }
        break;
      }

      case "pattern": {
        // Clear by custom pattern
        if (!pattern) {
          return NextResponse.json(
            { error: "Missing 'pattern' parameter" },
            { status: 400 }
          );
        }

        logger.info({ userId, pattern }, "Clearing cache by pattern");

        const keysDeleted = await clearCachePattern(pattern);
        result = buildPatternClearResult(pattern, keysDeleted);
        break;
      }

      case "memory": {
        // Clear memory cache only
        logger.info({ userId }, "Clearing memory cache");

        await cacheClient.clearMemory();
        result = buildMemoryClearResult();
        break;
      }

      default:
        return NextResponse.json(
          {
            error: `Invalid action: ${action}. Valid actions: all, user, pattern, memory`,
          },
          { status: 400 }
        );
    }

    return NextResponse.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    logger.error({ error }, "Error clearing cache");
    return NextResponse.json(
      {
        success: false,
        error: "Failed to clear cache",
      },
      { status: 500 }
    );
  }
}
