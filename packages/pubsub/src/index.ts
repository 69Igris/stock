/**
 * @usemoney/pubsub — shared Google Cloud Pub/Sub client + job publishers.
 *
 * Prefer the subpath imports (`@usemoney/pubsub/client`,
 * `@usemoney/pubsub/publish`); this barrel exists only for the package `main`
 * and parity with sibling packages.
 */

// Client factory
export {
  getPubSubClient,
  validateProjectId,
  __setPubSubClientForTests,
} from "./client";

// Job publishers
export {
  publishPairingJob,
  publishImportJob,
  publishSyncJob,
  publishResearchJob,
  publishResearchPreviewPlanJob,
  publishDocumentProcessJob,
  publishRoastJob,
  publishComparisonJob,
  publishLoginBriefingJob,
  publishL3AnalysisJob,
  publishStrategyScanJob,
  publishAccountDeletionJob,
  publishClerkDeleteSweepJob,
} from "./publish";
