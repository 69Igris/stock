/**
 * Test script to verify Redis connection
 * Run with: npx ts-node scripts/test-redis.ts
 */

import { getRedisClient, isRedisAvailable } from "../lib/redis/client";

async function testRedisConnection() {
  console.log("Testing Redis connection...\n");

  const client = getRedisClient();

  if (!client) {
    console.error("❌ Failed to create Redis client");
    console.log("\nPossible reasons:");
    console.log("  - REDIS_URL environment variable not set");
    console.log("  - Invalid Redis connection string");
    console.log("  - Redis server is not running");
    process.exit(1);
  }

  console.log("✅ Redis client created successfully\n");

  const available = await isRedisAvailable();

  if (!available) {
    console.error("❌ Redis is not available");
    console.log("\nPossible reasons:");
    console.log("  - Redis server is not running");
    console.log("  - Network connectivity issues");
    console.log("  - Incorrect credentials");
    process.exit(1);
  }

  console.log("✅ Redis is available and responding to PING\n");

  // Test basic operations
  try {
    console.log("Testing basic Redis operations...\n");

    // SET operation
    await client.set("test:key", "Hello Redis!", "EX", 10);
    console.log("✅ SET operation successful");

    // GET operation
    const value = await client.get("test:key");
    console.log(`✅ GET operation successful: ${value}`);

    // TTL operation
    const ttl = await client.ttl("test:key");
    console.log(`✅ TTL operation successful: ${ttl} seconds`);

    // DEL operation
    await client.del("test:key");
    console.log("✅ DEL operation successful");

    // Info
    const info = await client.info("server");
    const version = info.match(/redis_version:([^\r\n]+)/)?.[1];
    console.log(`\n✅ Redis version: ${version}`);

    console.log("\n🎉 All tests passed! Redis is working correctly.");
  } catch (error) {
    console.error("\n❌ Error during Redis operations:", error);
    process.exit(1);
  }

  process.exit(0);
}

testRedisConnection();
