/**
 * Custom Business Metrics - Datadog
 *
 * Wraps the `datadog-metrics` library for sending custom gauges,
 * counters, and histograms to Datadog without a local agent
 * (uses HTTP API directly).
 *
 * All metrics are no-ops when DD_API_KEY is not set (local dev).
 */

import datadogMetrics from "datadog-metrics";
import { DD_SITE, METRIC_PREFIX, getDefaultTags } from "./constants";

let initialized = false;

function ensureInit() {
  if (initialized) return;
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;

  datadogMetrics.init({
    apiKey,
    site: DD_SITE,
    // MONEY-1238 — the ONE definition of the prefix. `datadog-metrics`
    // prepends it to every name, so what a monitor must query is
    // `${METRIC_PREFIX}${name}`, never the bare name passed below.
    prefix: METRIC_PREFIX,
    defaultTags: getDefaultTags(),
    flushIntervalSeconds: 15,
  });
  initialized = true;
}

/**
 * Increment a counter metric.
 *
 * @example
 *   incrementCounter("cache.hit", 1, { module: "holdings", layer: "redis" });
 */
export function incrementCounter(
  name: string,
  value = 1,
  tags?: Record<string, string>,
) {
  ensureInit();
  if (!initialized) return;
  datadogMetrics.increment(name, value, formatTags(tags));
}

/**
 * Set a gauge metric.
 *
 * @example
 *   gauge("pairing.trades_processed", 150);
 */
export function gauge(
  name: string,
  value: number,
  tags?: Record<string, string>,
) {
  ensureInit();
  if (!initialized) return;
  datadogMetrics.gauge(name, value, formatTags(tags));
}

/**
 * Record a histogram metric (distribution of values).
 *
 * @example
 *   histogram("broker.sync.duration", 2340, { broker: "ZERODHA" });
 */
export function histogram(
  name: string,
  value: number,
  tags?: Record<string, string>,
) {
  ensureInit();
  if (!initialized) return;
  datadogMetrics.histogram(name, value, formatTags(tags));
}

/**
 * Flush all buffered metrics to Datadog.
 * Call this in graceful shutdown handlers.
 */
export function flushMetrics(): Promise<void> {
  if (!initialized) return Promise.resolve();
  return new Promise<void>((resolve) => {
    datadogMetrics.flush(resolve, () => resolve());
  });
}

/** Convert { key: value } tags to Datadog's "key:value" array format. */
function formatTags(tags?: Record<string, string>): string[] {
  if (!tags) return [];
  return Object.entries(tags).map(([k, v]) => `${k}:${v}`);
}

/**
 * Re-export everything under a single `metrics` namespace object
 * for convenient destructuring:
 *   import { metrics } from "@usemoney/datadog";
 *   metrics.increment("cache.hit", 1, { layer: "redis" });
 */
export const metrics = {
  increment: incrementCounter,
  gauge,
  histogram,
  flush: flushMetrics,
} as const;
