// Tracer
export { initTracer, tracer, tracerConfig, llmobsConfig } from "./tracer";
export type { TracerOptions } from "./tracer";

// LLM Observability (MONEY-1380)
export { llmWorkflow } from "./llmobs";
export type { MlApp, LlmWorkflowOptions } from "./llmobs";

// Metrics
export {
  metrics,
  incrementCounter,
  gauge,
  histogram,
  flushMetrics,
} from "./metrics";

// Constants
export {
  DD_SERVICES,
  DD_SITE,
  // MONEY-1469 — callers need this to state the FULLY-QUALIFIED series name
  // they emit. `datadog-metrics` prepends it, so a name passed WITH the prefix
  // ships `stockbook.stockbook.…`, which renders as NO DATA on the name anyone
  // would query.
  METRIC_PREFIX,
  DD_LOGS_INTAKE_URL,
  getDatadogEnv,
  getDefaultTags,
} from "./constants";
export type { DDService } from "./constants";
