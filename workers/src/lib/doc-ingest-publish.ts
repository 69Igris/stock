/**
 * Publishing a newly-stored document into the ingest lane — MONEY-1314.
 *
 * ONE function, and the FLAG IS READ INSIDE IT rather than at each call site.
 * That is the whole design: there are fifteen `stock_documents` writers across
 * eight files, and a gate repeated at each of them is a gate that will be
 * forgotten at the sixteenth. Callers call unconditionally; this decides.
 *
 * ## The flag
 *
 * `DOC_INGEST_REALTIME` ships ABSENT-meaning-off and must be the literal
 * string "true" to arm. Compared literally, never through `Boolean()` —
 * `Boolean("false")` is true, which would arm the one configuration meant to
 * keep it off.
 *
 * READ PER CALL, never captured in a module-scope const. A module-level read
 * freezes at import, and on a warm Cloud Run container that turns a redeployed
 * switch into no switch at all — the bug already documented on
 * `bse-client.ts`'s retry config and on both XBRL arm flags.
 *
 * ## Never throws
 *
 * A publish failure must not fail the SYNC that stored the document. The row
 * is already written and the backfill will reach it; losing the document
 * because we could not announce it would be strictly worse than announcing it
 * late. Failures are logged and counted by the caller if it wants them.
 */

import { getPubSubClient } from "@usemoney/pubsub/client";
// MONEY-1319 review — the DIRECT set, shared with every other selection
// over `mimeType`. This lane cannot open a container.
import { isDirectDocMimeType } from "@usemoney/core/market-data/doc-mime";
import { getTopicName, PUBSUB_TOPICS } from "@usemoney/types/pubsub";

const logger = {
  info: (m: string) => console.log(`[doc-ingest-publish] ${m}`),
  warn: (m: string) => console.warn(`[doc-ingest-publish] ${m}`),
};

/** The env var that arms realtime ingest. Absent = off. */
export const DOC_INGEST_REALTIME_ENV = "DOC_INGEST_REALTIME";

/** Armed only by the literal string "true". */
export function isRealtimeIngestArmed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[DOC_INGEST_REALTIME_ENV] === "true";
}

/**
 * Should a newly-stored document be announced to the ingest lane?
 *
 * DIRECTLY-READABLE bytes only. The lane's first act on anything else is to
 * mark it UNREADABLE, so publishing a `.txt` or `.json` document spends a
 * message and a Pub/Sub delivery to write a status the writer could have
 * written itself.
 *
 * `isDirectDocMimeType` NORMALISES rather than comparing exactly, so
 * `application/pdf;charset=UTF-8` still passes — the exact match on that
 * spelling is what made 1,211 rows permanently unreachable in MONEY-1255, and
 * that defect must not be rebuilt one lane over.
 *
 * It replaces a hand-rolled `mimeType.includes("pdf")`, which had the same
 * normalising effect and one blind spot the shared predicate does not: it could
 * not know what a CONTAINER is. This gate feeds `stock-document-ingest`, whose
 * convert lane hands the object's bytes to pdf-inspector and whose vision lane
 * hands them to a paid model — neither opens an archive. Reading the shared
 * DIRECT set means a future container type cannot reach either of them by
 * having a name that happens to contain the substring.
 */
export function shouldPublishIngest(args: {
  mimeType?: string | null;
  gcsPath?: string | null;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!isRealtimeIngestArmed(args.env ?? process.env)) return false;
  if (!args.gcsPath || args.gcsPath.trim() === "") return false;
  return !!args.mimeType && isDirectDocMimeType(args.mimeType);
}

/**
 * Announce one document. A no-op when the flag is off or the document is not
 * a PDF, so every writer can call it unconditionally.
 */
export async function publishDocumentIngest(doc: {
  id: string;
  mimeType?: string | null;
  gcsPath?: string | null;
}): Promise<boolean> {
  if (!shouldPublishIngest({ mimeType: doc.mimeType, gcsPath: doc.gcsPath })) {
    return false;
  }
  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(
      getTopicName(PUBSUB_TOPICS.STOCK_DOCUMENT_INGEST),
    );
    await topic.publishMessage({ json: { documentId: doc.id } });
    logger.info(`announced ${doc.id}`);
    return true;
  } catch (err) {
    // Swallowed on purpose — see the module docblock. The row exists; the
    // backfill will reach it.
    logger.warn(
      `failed to announce ${doc.id}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return false;
  }
}
