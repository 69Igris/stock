# @usemoney/datadog

> Datadog APM, metrics, and logging for UseMoney

## Features

- **APM Tracing**: `dd-trace` auto-instrumentation for Cloud Run workers
- **Custom Metrics**: Business metrics via HTTP API (works on Vercel)
- **Logger Transport**: Custom transport for Datadog log ingestion

## Architecture

| Environment | APM (dd-trace) | Metrics | Logs |
| ----------- | -------------- | ------- | ---- |
| Cloud Run   | Yes (sidecar)  | HTTP    | HTTP |
| Vercel      | No             | HTTP    | HTTP |

## Usage

```typescript
import { initTracer } from "@usemoney/datadog";
import { incrementCounter, gauge } from "@usemoney/datadog";

// Initialize APM (Cloud Run only)
initTracer({ service: "stockbook-workers" });

// Custom metrics (works everywhere)
incrementCounter("api.requests", 1, { endpoint: "/v1/holdings" });
gauge("portfolio.value", 150000, { userId: "..." });
```

## Exports

| Export             | Description                      |
| ------------------ | -------------------------------- |
| `initTracer`       | Initialize dd-trace APM          |
| `tracer`           | Tracer instance                  |
| `incrementCounter` | Increment counter metric         |
| `gauge`            | Set gauge metric                 |
| `histogram`        | Record histogram metric          |
| `flushMetrics`     | Manually flush metrics           |
| `DD_SERVICES`      | Service name constants           |
| `getDatadogEnv`    | Auto-detect environment          |
| `getDefaultTags`   | Default service/env/version tags |

## Environment Variables

```bash
DD_TRACE_ENABLED=true/false   # Enable APM (false on Vercel)
DD_API_KEY=...                 # Datadog API key
DD_SERVICE=stockbook-workers   # Service name
DD_ENV=production              # Environment
# DD_SITE is NOT an env var for the TypeScript emitters — it is the `DD_SITE`
# constant in src/constants.ts (us5.datadoghq.com since the Sep-2026 org move,
# MONEY-1229). The Cloud Run sidecars carry the same value as env; a test pins them.
```

## Documentation

See **CLAUDE.md** for technical details.
