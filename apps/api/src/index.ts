/**
 * UseMoney API Server - Local Development Entry Point
 *
 * In production, the API runs on Vercel via api/[[...route]].ts.
 * This file is only used for local development with `yarn dev`.
 */

// Datadog tracer - MUST be imported before all other application code
import { initTracer } from "@usemoney/datadog";
initTracer({ service: "stockbook-api" });

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(rootDir, "../..");

dotenv.config({ path: path.join(monorepoRoot, ".env") });
dotenv.config({ path: path.join(rootDir, ".env") });
dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });

import { initLogger } from "@usemoney/logger";

// Initialize logger with Datadog multistream (if DD_API_KEY is set)
await initLogger();

import app from "./app";
import { serve } from "@hono/node-server";

const port = parseInt(process.env.PORT || "8080", 10);

console.log(`
╔════════════════════════════════════════════╗
║         UseMoney API Server               ║
╠════════════════════════════════════════════╣
║  Environment: ${(process.env.NODE_ENV || "development").padEnd(27)}║
║  Port: ${port.toString().padEnd(34)}║
║  Health: http://localhost:${port}/health${" ".repeat(7)}║
║  API v1: http://localhost:${port}/v1${" ".repeat(10)}║
║  tRPC:   http://localhost:${port}/trpc${" ".repeat(8)}║
╚════════════════════════════════════════════╝
`);

const server = serve({ fetch: app.fetch, port });

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
