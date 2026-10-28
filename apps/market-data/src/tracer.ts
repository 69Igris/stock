/**
 * Datadog APM — REAL here, unlike `apps/api`.
 *
 * This service runs on Cloud Run with a `datadog-agent` sidecar, so spans have
 * somewhere to go. `apps/api` runs on Vercel where there is no agent, which is
 * why it sets `DD_APM_TRACING_ENABLED=false` and its spans die at the writer —
 * copying that wiring here would silently discard every span from a service
 * whose whole purpose is latency.
 *
 * `initTracer` latches, so importing this module twice is safe. It must be the
 * FIRST import in `index.ts`: dd-trace patches `http`, `ioredis` and the Mongo
 * driver at require/import time, and a module loaded before the tracer is a
 * module the tracer cannot see.
 */
import { initTracer } from "@usemoney/datadog";

initTracer({ service: "usemoney-market-data" });
