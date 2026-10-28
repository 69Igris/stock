/**
 * Integration test setup - runs once before all integration tests.
 *
 * 1. Checks RUN_INTEGRATION_TESTS=true; exits early if not set.
 * 2. Connects to QA MongoDB via a dedicated PrismaClient instance.
 * 3. Connects to QA Redis via ioredis.
 * 4. Exports `db` and `redis` clients for use in tests and helpers.
 *
 * Import this module at the top of every integration test file:
 *   import { db, redis } from "../setup.js";
 */

import { before } from "node:test";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { isIntegrationEnabled, loadConfig } from "./env.js";

// ----- Shared clients (populated in before() hook) -----

export let db: PrismaClient;
export let redis: Redis;

// ----- Guard: skip when integration flag is not set -----

if (!isIntegrationEnabled()) {
  console.log(
    "Skipping integration tests (RUN_INTEGRATION_TESTS is not set to true).",
  );
  process.exit(0);
}

// ----- Setup hook -----

before(async () => {
  const config = loadConfig();

  // Connect Prisma to QA database
  db = new PrismaClient({
    datasourceUrl: config.databaseUrl,
    log: ["error", "warn"],
  });
  await db.$connect();
  console.log("[integration:setup] Connected to QA MongoDB");

  // Connect Redis to QA instance
  redis = new Redis(config.redisUrl, {
    connectTimeout: 10_000,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });

  await new Promise<void>((resolve, reject) => {
    redis.once("ready", () => {
      console.log("[integration:setup] Connected to QA Redis");
      resolve();
    });
    redis.once("error", (err) => {
      reject(new Error(`Redis connection failed: ${err.message}`));
    });
  });
});
