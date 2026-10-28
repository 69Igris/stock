/**
 * Shared Pub/Sub client factory (@usemoney/pubsub).
 *
 * Reconciles the two pre-migration implementations into ONE (both now deleted):
 *   - apps/web/lib/pubsub/client.ts          (publisher, Vercel)
 *   - workers/src/lib/pubsub-client.ts       (consumer, Cloud Run)
 *
 * Both exposed `getPubSubClient()`; the worker also exported the pure
 * `validateProjectId()` helper. This module keeps BOTH names 1:1 so consumers
 * swap import paths mechanically.
 *
 * Credentials resolve via the shared `googleCredentials()` resolver
 * (@usemoney/core/gemini/credentials) — the worker's behaviour, which is a
 * strict superset of the web one: base64 (GCP_SERVICE_ACCOUNT_KEY_BASE64) still
 * wins (precedence 1, so production behaviour is unchanged), then the
 * GOOGLE_APPLICATION_CREDENTIALS_JSON / GOOGLE_APPLICATION_CREDENTIALS / ADC
 * fallbacks the web copy lacked:
 * - GCP_SERVICE_ACCOUNT_KEY_BASE64 (production / Vercel)
 * - GOOGLE_APPLICATION_CREDENTIALS_JSON (raw JSON or base64)
 * - GOOGLE_APPLICATION_CREDENTIALS file path (local development)
 * - else Application Default Credentials (Cloud Run attached SA)
 *
 * `projectId` is ALWAYS taken from the explicit GCP_PROJECT_ID env (never the
 * resolver's derived value) — without it the gRPC transport in google-gax may
 * fail to attach credentials from the metadata server on Cloud Run.
 */

import { PubSub } from "@google-cloud/pubsub";
import { googleCredentials } from "@usemoney/core/gemini/credentials";

let pubsubClient: PubSub | null = null;

/**
 * Validates that GCP_PROJECT_ID is present.
 *
 * Returns a discriminated result so the caller can either throw or branch.
 * `getPubSubClient` throws with `error` when `valid` is false.
 */
export function validateProjectId(
  projectId: string | undefined,
): { valid: true; projectId: string } | { valid: false; error: string } {
  if (!projectId) {
    return {
      valid: false,
      error: "GCP_PROJECT_ID environment variable is required for Pub/Sub",
    };
  }
  return { valid: true, projectId };
}

/**
 * Get or initialize the singleton Pub/Sub client.
 *
 * Constructing a `PubSub` does NOT open a network connection, so the singleton
 * is safe to create eagerly on first publish/subscribe and cache for the life
 * of the process.
 */
export function getPubSubClient(): PubSub {
  if (!pubsubClient) {
    const projectIdResult = validateProjectId(process.env.GCP_PROJECT_ID);

    if (!projectIdResult.valid) {
      throw new Error(projectIdResult.error);
    }
    const { projectId } = projectIdResult;

    // Spread the resolver first, then pin projectId from the explicit
    // GCP_PROJECT_ID env — never the resolver's derived value. Must pass
    // projectId explicitly: without it the gRPC transport in google-gax may
    // fail to attach credentials from the metadata server, resulting in
    // "Method doesn't allow unregistered callers" PERMISSION_DENIED errors.
    pubsubClient = new PubSub({ ...googleCredentials(), projectId });
  }
  return pubsubClient;
}

/**
 * Test seam: inject a fake PubSub (or null to reset the singleton). Needed
 * because these packages are ESM ("type":"module"), where the CJS
 * `require.cache` module-swap trick used by the apps/web suite doesn't work and
 * `node:test`'s `mock.module` needs an experimental flag (unused in this repo).
 * Production code never calls this.
 */
export function __setPubSubClientForTests(client: PubSub | null): void {
  pubsubClient = client;
}
