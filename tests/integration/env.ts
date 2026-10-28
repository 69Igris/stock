/**
 * Integration test environment configuration.
 *
 * Validates that required environment variables are set and exports
 * a typed config object for use by setup, teardown, and test helpers.
 *
 * Required env vars (typically injected by scripts/ops/test-env.sh):
 *   - DATABASE_URL   - QA MongoDB connection string
 *   - REDIS_URL      - QA Redis connection string
 *   - WORKER_URL     - QA Cloud Run worker base URL
 *   - RUN_INTEGRATION_TESTS - must be "true" to enable tests
 */

export interface IntegrationConfig {
  databaseUrl: string;
  redisUrl: string;
  workerUrl: string;
}

/**
 * Returns true when integration tests are enabled via env var.
 */
export function isIntegrationEnabled(): boolean {
  return process.env.RUN_INTEGRATION_TESTS === "true";
}

/**
 * Validates required env vars and returns a typed config.
 * Throws if any required variable is missing.
 */
export function loadConfig(): IntegrationConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  const workerUrl = process.env.WORKER_URL;

  const missing: string[] = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!redisUrl) missing.push("REDIS_URL");
  if (!workerUrl) missing.push("WORKER_URL");

  if (missing.length > 0) {
    throw new Error(
      `Integration tests require the following env vars: ${missing.join(", ")}.\n` +
        `Run: source scripts/ops/test-env.sh   (to fetch QA secrets from GCP Secret Manager)`,
    );
  }

  return {
    databaseUrl: databaseUrl!,
    redisUrl: redisUrl!,
    workerUrl: workerUrl!,
  };
}
