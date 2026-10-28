/**
 * Clear Redis Cache Script
 *
 * Usage:
 * npx tsx scripts/clear-cache.ts [action] [options]
 *
 * Actions:
 * - all: Clear all Redis cache (NUCLEAR OPTION)
 * - user <userId>: Clear all cache for specific user
 * - pattern <pattern>: Clear cache matching Redis pattern
 * - memory: Clear memory cache only
 * - stats: Show cache statistics
 *
 * Examples:
 * npx tsx scripts/clear-cache.ts all
 * npx tsx scripts/clear-cache.ts user user_123abc
 * npx tsx scripts/clear-cache.ts pattern "dashboard:*"
 * npx tsx scripts/clear-cache.ts stats
 */

import Redis from "ioredis";
import { config } from "dotenv";

// Load environment variables
config();

const REDIS_URL = process.env.REDIS_URL;

if (!REDIS_URL) {
  console.error("❌ Error: REDIS_URL not found in environment variables");
  process.exit(1);
}

async function main() {
  const action = process.argv[2];
  const param = process.argv[3];

  if (!action) {
    console.log(`
🧹 Redis Cache Cleaner
=====================

Usage: npx tsx scripts/clear-cache.ts [action] [options]

Actions:
  all                     Clear ALL Redis cache (⚠️  NUCLEAR OPTION)
  user <userId>           Clear all cache for specific user
  pattern <pattern>       Clear cache matching Redis pattern
  memory                  Clear memory cache only (server restart required)
  stats                   Show cache statistics

Examples:
  npx tsx scripts/clear-cache.ts all
  npx tsx scripts/clear-cache.ts user user_123abc
  npx tsx scripts/clear-cache.ts pattern "dashboard:*"
  npx tsx scripts/clear-cache.ts stats
    `);
    process.exit(0);
  }

  // Create Redis client
  const redis = new Redis(REDIS_URL as string, {
    connectTimeout: 10000,
    retryStrategy: (times: number) => {
      const delay = Math.min(times * 50, 3000);
      return delay;
    },
    maxRetriesPerRequest: 3,
  });

  redis.on("error", (err) => console.error("Redis Client Error:", err));

  try {
    console.log("🔌 Connecting to Redis...");
    // ioredis connects automatically, wait for ready event
    await new Promise<void>((resolve, reject) => {
      redis.once("ready", () => resolve());
      redis.once("error", (err) => reject(err));
    });
    console.log("✅ Connected to Redis\n");

    switch (action) {
      case "all": {
        console.log("⚠️  WARNING: This will clear ALL Redis cache!");
        console.log("⏳ Getting key count...");

        const keyCount = await redis.dbsize();
        console.log(`📊 Total keys: ${keyCount}`);

        console.log("🗑️  Flushing database...");
        await redis.flushdb();

        console.log(
          `✅ Successfully cleared all Redis cache (${keyCount} keys deleted)`
        );
        break;
      }

      case "user": {
        if (!param) {
          console.error("❌ Error: User ID required");
          console.log("Usage: npx tsx scripts/clear-cache.ts user <userId>");
          process.exit(1);
        }

        console.log(`🧹 Clearing cache for user: ${param}`);

        // Find all keys for this user
        const patterns = [
          `dashboard:${param}:*`,
          `positions:${param}:*`,
          `holdings:${param}:*`,
          `trades:${param}:*`,
          `fire:${param}:*`,
          `user:${param}:*`,
          `brokers:${param}:*`,
          `chat:${param}:*`,
          `subscription:${param}:*`,
          `mutual-funds:${param}:*`,
        ];

        let totalDeleted = 0;
        for (const pattern of patterns) {
          const keys = await redis.keys(pattern);
          if (keys.length > 0) {
            await redis.del(keys);
            console.log(`  ✓ Deleted ${keys.length} keys matching: ${pattern}`);
            totalDeleted += keys.length;
          }
        }

        console.log(
          `✅ Successfully cleared cache for user ${param} (${totalDeleted} keys deleted)`
        );
        break;
      }

      case "pattern": {
        if (!param) {
          console.error("❌ Error: Pattern required");
          console.log(
            "Usage: npx tsx scripts/clear-cache.ts pattern <pattern>"
          );
          console.log(
            'Example: npx tsx scripts/clear-cache.ts pattern "dashboard:*"'
          );
          process.exit(1);
        }

        console.log(`🔍 Finding keys matching pattern: ${param}`);

        const keys = await redis.keys(param);
        console.log(`📊 Found ${keys.length} keys`);

        if (keys.length > 0) {
          console.log("🗑️  Deleting keys...");
          await redis.del(keys);
          console.log(`✅ Successfully deleted ${keys.length} keys`);
        } else {
          console.log("ℹ️  No keys found matching pattern");
        }
        break;
      }

      case "stats": {
        console.log("📊 Cache Statistics");
        console.log("==================\n");

        const dbSize = await redis.dbsize();
        const info = await redis.info("stats");

        console.log(`Total Keys: ${dbSize}`);
        console.log("\nRedis Stats:");

        // Parse info string
        const lines = info.split("\r\n");
        const statsObj: Record<string, string> = {};

        for (const line of lines) {
          if (line && !line.startsWith("#")) {
            const [key, value] = line.split(":");
            if (key && value) {
              statsObj[key] = value;
            }
          }
        }

        console.log(
          `  Total Connections: ${statsObj.total_connections_received || "N/A"}`
        );
        console.log(
          `  Total Commands: ${statsObj.total_commands_processed || "N/A"}`
        );
        console.log(`  Keyspace Hits: ${statsObj.keyspace_hits || "N/A"}`);
        console.log(`  Keyspace Misses: ${statsObj.keyspace_misses || "N/A"}`);

        if (statsObj.keyspace_hits && statsObj.keyspace_misses) {
          const hits = parseInt(statsObj.keyspace_hits);
          const misses = parseInt(statsObj.keyspace_misses);
          const total = hits + misses;
          const hitRate =
            total > 0 ? ((hits / total) * 100).toFixed(2) : "0.00";
          console.log(`  Hit Rate: ${hitRate}%`);
        }

        // Sample some keys
        console.log("\n📝 Sample Keys (first 10):");
        const sampleKeys = await redis.keys("*");
        const displayKeys = sampleKeys.slice(0, 10);

        if (displayKeys.length > 0) {
          displayKeys.forEach((key, i) => {
            console.log(`  ${i + 1}. ${key}`);
          });

          if (sampleKeys.length > 10) {
            console.log(`  ... and ${sampleKeys.length - 10} more`);
          }
        } else {
          console.log("  (empty)");
        }
        break;
      }

      case "memory": {
        console.log("ℹ️  Memory cache is stored in the application process");
        console.log(
          "⚠️  To clear memory cache, restart the application server"
        );
        console.log(
          "   Or use the API: POST /api/cache/clear with { action: 'memory' }"
        );
        break;
      }

      default:
        console.error(`❌ Unknown action: ${action}`);
        console.log("Run script without arguments to see usage");
        process.exit(1);
    }
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  } finally {
    redis.disconnect();
    console.log("\n🔌 Disconnected from Redis");
  }
}

main();
