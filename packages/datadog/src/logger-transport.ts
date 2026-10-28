/**
 * Pino Transport - Datadog Logs HTTP API
 *
 * Batches log lines and sends them to Datadog's HTTP Logs intake.
 * Automatically includes dd.trace_id / dd.span_id when present
 * (injected by dd-trace's logInjection: true).
 *
 * Usage as a Pino transport target:
 *   {
 *     target: "@usemoney/datadog/logger-transport",
 *     options: { apiKey: "...", service: "stockbook-web" }
 *   }
 */

import { Writable } from "node:stream";

/**
 * The Datadog log stream, plus the one thing a caller cannot otherwise reach:
 * a flush it can await. `pino.multistream()` has no `flush`, so a shutdown that
 * goes through pino silently flushes nothing.
 */
export interface DatadogLogStream extends Writable {
  flushNow: () => Promise<void>;
}
import { DD_LOGS_INTAKE_URL, getDatadogEnv } from "./constants";

interface DatadogTransportOptions {
  /** Datadog API key (required). Falls back to DD_API_KEY env var. */
  apiKey?: string;
  /** Service name tag. Falls back to DD_SERVICE env var. */
  service?: string;
  /** Flush interval in ms (default 5000). */
  flushIntervalMs?: number;
  /** Max batch size before forced flush (default 100). */
  maxBatchSize?: number;
}

function build(opts: DatadogTransportOptions) {
  const resolvedKey = opts.apiKey || process.env.DD_API_KEY;
  if (!resolvedKey) {
    // No API key - return a passthrough that does nothing
    return new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }

  const apiKey: string = resolvedKey;
  const service = opts.service || process.env.DD_SERVICE || "stockbook";
  const env = getDatadogEnv();
  const flushIntervalMs = opts.flushIntervalMs ?? 5000;
  const maxBatchSize = opts.maxBatchSize ?? 100;

  let buffer: Record<string, unknown>[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  async function flush() {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    const payload = batch.map((log) => ({
      ...log,
      ddsource: "nodejs",
      service,
      ddtags: `env:${env}`,
    }));

    try {
      await fetch(DD_LOGS_INTAKE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "DD-API-KEY": apiKey,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      // Swallow network errors - logging should never crash the app
    }
  }

  flushTimer = setInterval(flush, flushIntervalMs);
  // Unref so the timer doesn't keep the process alive
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }

  const writable = new Writable({
    objectMode: true,
    write(chunk: Buffer | string, _encoding, callback) {
      try {
        const line =
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        const parsed = JSON.parse(line) as Record<string, unknown>;
        buffer.push(parsed);
        if (buffer.length >= maxBatchSize) {
          flush().then(
            () => callback(),
            () => callback(),
          );
          return;
        }
      } catch {
        // Ignore unparseable lines
      }
      callback();
    },
    final(callback) {
      if (flushTimer) clearInterval(flushTimer);
      flush().then(
        () => callback(),
        () => callback(),
      );
    },
  });

  // A REAL flush handle, hung off the stream.
  //
  // `flushLogs()` used to call pino's `root.flush(cb)`, and `pino.multistream()`
  // does not implement `flush` — it exposes write/add/flushSync/end/clone — so
  // pino fell through to `cb()` having flushed NOTHING. Measured: a job that
  // logged its outcome and returned shipped zero lines, and a 7-second job
  // shipped only the line that happened to fall on the 5s interval, losing the
  // final `[job-outcome]` line. That is precisely the window a shutdown flush
  // exists to protect, so the guarantee was inverted: it read as flushed and
  // was not.
  //
  // Attaching the closure is what makes it reachable — the caller has the
  // stream, not this scope.
  (writable as DatadogLogStream).flushNow = flush;
  return writable as DatadogLogStream;
}

export default build;
