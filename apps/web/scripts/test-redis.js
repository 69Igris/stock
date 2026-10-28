/**
 * Test script to verify Redis connection
 * Run with: node scripts/test-redis.js
 */

const Redis = require("ioredis");

async function testRedisConnection() {
  console.log("Testing Redis connection...\n");

  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.error("❌ REDIS_URL environment variable not set");
    console.log("\nPlease set REDIS_URL in your .env file");
    process.exit(1);
  }

  console.log(`Using Redis URL: ${redisUrl.replace(/:[^:@]+@/, ":****@")}\n`);

  const client = new Redis(redisUrl, {
    connectTimeout: 10000,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 3000);
      return delay;
    },
    maxRetriesPerRequest: 3,
  });

  client.on("connect", () => {
    console.log("✅ Connected to Redis");
  });

  client.on("ready", () => {
    console.log("✅ Redis client ready\n");
  });

  client.on("error", (error) => {
    console.error("❌ Redis client error:", error.message);
  });

  try {
    // Wait for connection
    await new Promise((resolve, reject) => {
      client.once("ready", resolve);
      client.once("error", reject);
      setTimeout(() => reject(new Error("Connection timeout")), 15000);
    });

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

    // Test feature flag caching
    console.log("\nTesting feature flag caching...\n");

    const testFlags = {
      "/tradebook": true,
      "/positions": false,
      "/holdings": true,
      "/paper-trading": true,
      "/discover": false,
      "/analysis": true,
      "/tutor": true,
    };

    const testUser = "test_user_123";
    const flagKey = `ff:${testUser}`;

    await client.setex(
      flagKey,
      300,
      JSON.stringify({
        flags: testFlags,
        version: "abc12345",
        timestamp: Date.now(),
      })
    );
    console.log(`✅ Cached feature flags for user: ${testUser}`);

    const cachedFlags = await client.get(flagKey);
    const parsed = JSON.parse(cachedFlags);
    console.log(`✅ Retrieved cached flags: version ${parsed.version}`);

    await client.del(flagKey);
    console.log(`✅ Cleaned up test data`);

    console.log("\n🎉 All tests passed! Redis is working correctly.");

    await client.quit();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error during Redis operations:", error.message);
    await client.quit();
    process.exit(1);
  }
}

testRedisConnection();
