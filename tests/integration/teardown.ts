/**
 * Integration test teardown - runs once after all integration tests.
 *
 * Disconnects Prisma and Redis clients that were established in setup.ts.
 *
 * Import this module alongside setup.ts in every integration test file:
 *   import "./teardown.js";
 */

import { after } from "node:test";
import { db, redis } from "./setup.js";

after(async () => {
  // Disconnect Prisma
  if (db) {
    await db.$disconnect();
    console.log("[integration:teardown] Disconnected from QA MongoDB");
  }

  // Disconnect Redis
  if (redis) {
    redis.disconnect();
    console.log("[integration:teardown] Disconnected from QA Redis");
  }
});
