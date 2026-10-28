/**
 * Health Check Routes
 *
 * Endpoints for monitoring and health checks.
 *
 * The response-shaping logic is extracted into exported pure functions
 * (`buildHealthResponse`, `buildReadyResponse`) so the wire contract — the
 * health payload fields, the "unknown" dependency status, and the
 * degraded→503 / healthy→200 mapping — is tested against the REAL source
 * instead of an inline copy. The Hono handlers below are thin wrappers that
 * call them.
 *
 * @see apps/api/__tests__/routes/health.test.ts
 */

import { Hono } from "hono";

/** Basic `/health` payload. */
export interface HealthCheckResponse {
  status: string;
  timestamp: string;
  version?: string;
  environment?: string;
  region?: string;
}

/** Status of a single readiness dependency check. */
export interface DependencyCheck {
  status: string;
  latency?: number;
}

/** `/health/ready` payload. */
export interface ReadyCheckResponse {
  status: string;
  timestamp: string;
  checks: Record<string, DependencyCheck>;
}

/** Build the `GET /health` payload (env-driven version/environment/region). */
export function buildHealthResponse(): HealthCheckResponse {
  return {
    status: "healthy",
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "1.0.0",
    environment: process.env.NODE_ENV || "development",
    region: process.env.CLOUD_RUN_REGION || "local",
  };
}

/**
 * Map a set of dependency checks to a readiness payload + HTTP status.
 *
 * Overall status is "degraded" (503) only when at least one check is literally
 * "unhealthy"; any other status ("unknown", "slow", …) is treated as healthy
 * (200) so an unimplemented check never falsely reports "unhealthy".
 */
export function buildReadyResponseFromChecks(
  checks: Record<string, DependencyCheck>,
): { body: ReadyCheckResponse; status: number } {
  const hasUnhealthy = Object.values(checks).some(
    (check) => check.status === "unhealthy",
  );

  return {
    body: {
      status: hasUnhealthy ? "degraded" : "healthy",
      timestamp: new Date().toISOString(),
      checks,
    },
    status: hasUnhealthy ? 503 : 200,
  };
}

/**
 * Build the `GET /health/ready` payload + status.
 *
 * Database and Redis checks are not yet implemented, so they report "unknown"
 * instead of falsely claiming "healthy".
 */
export function buildReadyResponse(): {
  body: ReadyCheckResponse;
  status: number;
} {
  const checks: Record<string, DependencyCheck> = {};

  checks.database = { status: "unknown" };
  checks.redis = { status: "unknown" };

  return buildReadyResponseFromChecks(checks);
}

const healthRoutes = new Hono();

/**
 * Basic health check
 */
healthRoutes.get("/", (c) => {
  return c.json(buildHealthResponse());
});

/**
 * Detailed health check with dependencies
 */
healthRoutes.get("/ready", async (c) => {
  const { body, status } = buildReadyResponse();
  return c.json(body, status as 200 | 503);
});

/**
 * Liveness probe - just checks if the server is running
 */
healthRoutes.get("/live", (c) => {
  return c.text("OK", 200);
});

export default healthRoutes;
